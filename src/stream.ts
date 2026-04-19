import type {
  AgentEvent,
  AgentStreamResult,
  AgentUsage,
  SessionResult,
  ProviderName,
  AgentStream,
} from "./types.js";
import { AgentError } from "./errors.js";

/**
 * Create a Vercel-AI-SDK-style stream result from a provider's raw event stream.
 *
 * Single underlying stream, eagerly consumed into a buffer so multiple
 * consumers (fullStream, textStream, await result, etc.) each see every event.
 */
export function createStreamResult(
  source: AgentStream,
  providerName: ProviderName,
  abortSignal?: AbortSignal,
): AgentStreamResult {
  // Internal abort controller (merged with caller's signal)
  const ac = new AbortController();
  if (abortSignal) {
    if (abortSignal.aborted) {
      ac.abort(abortSignal.reason);
    } else {
      abortSignal.addEventListener("abort", () => ac.abort(abortSignal.reason), { once: true });
    }
  }

  // --- Shared state ---
  const buffer: AgentEvent[] = [];
  let done = false;
  let drainError: Error | undefined;

  // Waiters: consumers waiting for new events
  type Waiter = () => void;
  let waiters: Waiter[] = [];
  const notify = () => {
    // Drain in a loop so any waiter added synchronously by a resolver while we
    // are notifying still observes the update before we return.
    while (waiters.length > 0) {
      const w = waiters;
      waiters = [];
      for (const fn of w) fn();
    }
  };

  // Promise resolvers for sessionId, text, result, usage
  let resolveSessionId: (v: string) => void;
  let rejectSessionId: (e: Error) => void;
  const sessionIdPromise = new Promise<string>((res, rej) => {
    resolveSessionId = res;
    rejectSessionId = rej;
  });
  // Attach a no-op rejection handler so callers who never await `sessionId`
  // (e.g. cancelled / aborted streams) don't trigger an unhandled-rejection
  // crash. The original `sessionIdPromise` will still throw if anyone does
  // `await turn.sessionId`, because attaching a `.catch()` does not suppress
  // rejection on the source promise.
  sessionIdPromise.catch(() => {});

  let resolveText: (v: string) => void;
  const textPromise = new Promise<string>((res) => {
    resolveText = res;
  });

  let resolveResult: (v: SessionResult) => void;
  let rejectResult: (e: Error) => void;
  const resultPromise = new Promise<SessionResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  resultPromise.catch(() => {});

  let resolveUsage: (v: AgentUsage | undefined) => void;
  const usagePromise = new Promise<AgentUsage | undefined>((res) => {
    resolveUsage = res;
  });

  // Accumulation state
  let sessionIdResolved = false;
  let textParts: string[] = [];
  let lastUsage: AgentUsage | undefined;
  let resultResolved = false;
  let currentSessionId: string | undefined;
  let turnEndEmitted = false;
  // Captures the first error event so late failures (sessionId never emitted)
  // can surface the underlying cause instead of a generic "stream ended" message.
  let lastErrorEvent: AgentError | undefined;

  // --- Eagerly consume the source stream ---
  const _drainPromise = (async () => {
    try {
      for await (const event of source) {
        if (ac.signal.aborted) {
          break;
        }

        buffer.push(event);

        if (event.type === "turn_end") {
          turnEndEmitted = true;
        }

        // Process event for promise resolution
        switch (event.type) {
          case "session":
            if (!sessionIdResolved) {
              currentSessionId = event.sessionId;
              sessionIdResolved = true;
              resolveSessionId!(event.sessionId);
            }
            break;

          case "session_forked":
            if (!sessionIdResolved) {
              currentSessionId = event.sessionId;
              sessionIdResolved = true;
              resolveSessionId!(event.sessionId);
            }
            break;

          case "text_delta":
            textParts.push(event.delta);
            break;

          case "usage":
            lastUsage = {
              inputTokens: event.inputTokens ?? 0,
              outputTokens: event.outputTokens ?? 0,
              cacheReadTokens: event.cachedReadTokens,
              cacheWriteTokens: event.cachedWriteTokens,
              costUsd: event.costUsd,
            };
            break;

          case "result":
            if (!sessionIdResolved) {
              currentSessionId = event.sessionId;
              sessionIdResolved = true;
              resolveSessionId!(event.sessionId);
            }
            resultResolved = true;
            // Prefer accumulated text from text_delta events over event.text,
            // since some providers (e.g. copilot) emit result with empty text.
            const accumulatedText = textParts.length > 0 ? textParts.join("") : event.text;
            resolveResult!({
              sessionId: event.sessionId,
              text: accumulatedText,
              provider: providerName,
              raw: event.raw,
            });
            break;

          case "error": {
            const err = new AgentError("provider", event.message, event.raw);
            lastErrorEvent = err;
            if (!resultResolved) {
              resultResolved = true;
              rejectResult!(err);
            }
            break;
          }
        }

        notify();
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      drainError = err;

      if (!resultResolved) {
        resultResolved = true;
        rejectResult!(err);
      }
    } finally {
      // If aborted, signal the source iterator to stop so the underlying
      // provider can tear down its loop instead of hanging / emitting more
      // events after we've synthesized our own terminator.
      if (ac.signal.aborted) {
        const maybeGen = source as { return?: (value?: unknown) => Promise<unknown> };
        if (typeof maybeGen.return === "function") {
          try {
            await maybeGen.return();
          } catch {
            // Ignore errors from source teardown; we're already aborting.
          }
        }
      }

      // If aborted without a natural turn_end, synthesize a cancelled terminator
      // so callers iterating fullStream see a structured boundary event.
      if (ac.signal.aborted && !turnEndEmitted) {
        buffer.push({ type: "turn_end", stopReason: "cancelled" });
        turnEndEmitted = true;
      }

      done = true;

      // Resolve text with accumulated deltas
      const fullText = textParts.join("");
      resolveText!(fullText);

      // Resolve usage
      resolveUsage!(lastUsage);

      // If sessionId was never emitted, reject it — prefer the upstream error
      // (drain throw OR error event seen on the stream) so callers see the
      // actual cause instead of the generic terminator message.
      if (!sessionIdResolved) {
        const err =
          drainError ??
          lastErrorEvent ??
          new AgentError("provider", "Stream ended without a session event");
        rejectSessionId!(err);
      }

      // If result was never emitted, resolve with accumulated text
      if (!resultResolved) {
        if (currentSessionId) {
          resolveResult!({
            sessionId: currentSessionId,
            text: fullText,
            provider: providerName,
            raw: undefined,
          });
        } else {
          rejectResult!(
            drainError ?? new AgentError("provider", "Stream ended without a result event"),
          );
        }
      }

      notify();
    }
  })().catch((err) => {
    // The IIFE's own try/catch should normally swallow errors and route them
    // through rejectResult/rejectSessionId, but defend against bugs that let
    // an exception escape (e.g. a sync throw from a resolver). Surface as a
    // result rejection if the stream hasn't already settled, otherwise warn.
    if (!resultResolved) {
      resultResolved = true;
      rejectResult!(err instanceof Error ? err : new Error(String(err)));
    } else {
      console.warn("agent-sdk: post-resolution drain error", err);
    }
  });

  // --- Helper: wait for new events or stream end ---
  function waitForNew(): Promise<void> {
    if (done) return Promise.resolve();
    return new Promise<void>((res) => {
      waiters.push(res);
    });
  }

  // --- Create an independent consumer iterator from the buffer ---
  async function* iterateFrom(startIdx: number): AsyncGenerator<AgentEvent> {
    let idx = startIdx;
    while (true) {
      while (idx < buffer.length) {
        yield buffer[idx]!;
        idx++;
      }
      if (done) break;
      await waitForNew();
    }
  }

  // --- textStream: yields only text deltas ---
  async function* textStream(): AsyncIterable<string> {
    for await (const event of iterateFrom(0)) {
      if (event.type === "text_delta") {
        yield event.delta;
      }
    }
  }

  // --- Build the result object ---
  const streamResult: AgentStreamResult = {
    get sessionId() {
      return sessionIdPromise;
    },
    get text() {
      return textPromise;
    },
    get result() {
      return resultPromise;
    },
    get usage() {
      return usagePromise;
    },
    get fullStream(): AsyncIterable<AgentEvent> {
      return iterateFrom(0);
    },
    get textStream(): AsyncIterable<string> {
      return textStream();
    },
    [Symbol.asyncIterator]() {
      // NOTE: Abandoning the iterator without calling abort() will leak the
      // buffer until process exit; call abort() or iterate to completion to
      // release resources.
      return iterateFrom(0)[Symbol.asyncIterator]();
    },
    abort(reason?: unknown) {
      // Aborting the internal AbortController short-circuits the drain loop
      // (it checks `ac.signal.aborted` on every iteration) and propagates
      // cancellation to any caller-merged signal wired through `abortSignal`.
      ac.abort(reason ?? new AgentError("aborted", "Stream aborted by caller"));
    },
  };

  return streamResult;
}
