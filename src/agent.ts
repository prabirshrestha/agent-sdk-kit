import type {
  Agent,
  CreateAgentOptions,
  RunOptions,
  RunInput,
  AgentStreamResult,
  StreamOp,
} from "./types.js";
import { createStreamResult } from "./stream.js";
import { AgentError } from "./errors.js";

/**
 * Merge agent-level options (systemPrompt, abortSignal, tools, etc.) with per-call options.
 *
 * Returns the merged options together with a `cleanup()` function. When two
 * abort signals are merged into a derived AbortController, `cleanup()` removes
 * the abort listeners from BOTH source signals and drops the reference to the
 * internal AbortController so it can be garbage-collected. Callers must invoke
 * `cleanup()` once the resulting stream has completed (e.g. via the result
 * promise's `.finally`) to avoid leaking listeners on long-lived signals.
 */
function mergeCallOpts(
  agentOpts: CreateAgentOptions,
  callOpts?: RunOptions,
): { merged: RunOptions; cleanup: () => void } {
  const merged: RunOptions = { ...callOpts };
  let cleanup: () => void = () => {};

  // Merge abort signals
  if (agentOpts.abortSignal && callOpts?.abortSignal) {
    let ac: AbortController | null = new AbortController();
    const sig1 = agentOpts.abortSignal;
    const sig2 = callOpts.abortSignal;
    const listeners: Array<{ sig: AbortSignal; fn: () => void }> = [];

    cleanup = () => {
      for (const { sig, fn } of listeners) {
        sig.removeEventListener("abort", fn);
      }
      listeners.length = 0;
      // Drop the AbortController so it isn't pinned by closures past cleanup.
      ac = null;
    };

    const handler1 = () => {
      ac?.abort(sig1.reason);
      cleanup();
    };
    const handler2 = () => {
      ac?.abort(sig2.reason);
      cleanup();
    };

    listeners.push({ sig: sig1, fn: handler1 }, { sig: sig2, fn: handler2 });
    sig1.addEventListener("abort", handler1, { once: true });
    sig2.addEventListener("abort", handler2, { once: true });

    merged.abortSignal = ac.signal;
  } else {
    merged.abortSignal = callOpts?.abortSignal ?? agentOpts.abortSignal;
  }

  // System prompt: per-call overrides agent-level
  if (!merged.systemPrompt && agentOpts.systemPrompt) {
    merged.systemPrompt = agentOpts.systemPrompt;
  }

  // Tools: merge agent-level and per-call, with per-call winning
  if (agentOpts.tools || callOpts?.tools) {
    merged.tools = { ...agentOpts.tools, ...callOpts?.tools };
  }

  // MCP servers: concat agent-level and per-call
  if (agentOpts.mcpServers || callOpts?.mcpServers) {
    merged.mcpServers = [...(agentOpts.mcpServers ?? []), ...(callOpts?.mcpServers ?? [])];
  }

  // Permission handler: per-call overrides agent-level
  if (!merged.onPermissionRequest && agentOpts.onPermissionRequest) {
    merged.onPermissionRequest = agentOpts.onPermissionRequest;
  }

  return { merged, cleanup };
}

/**
 * Create an Agent facade over a Provider.
 */
export function createAgent(opts: CreateAgentOptions): Agent {
  const provider = opts.provider;
  let disposed = false;

  const agent: Agent = {
    get provider() {
      return provider.name;
    },
    get transport() {
      return provider.transport;
    },

    run(input: RunInput): AgentStreamResult {
      if (disposed) {
        throw new AgentError("internal", "Agent has been disposed");
      }

      const { prompt: promptInput, options: callOpts } = input;

      // AsyncIterable (streaming-input multi-turn) is type-supported but no
      // transport implements it yet — surface a clear error.
      if (typeof promptInput !== "string") {
        throw new AgentError(
          "not_supported",
          "AsyncIterable<UserMessage> prompt (streaming-input mode) is not yet implemented. Pass a string prompt.",
        );
      }
      const promptText = promptInput;

      if (!promptText?.trim() && !callOpts?.attachments?.length && !callOpts?.parts?.length) {
        throw new AgentError("invalid_input", "Empty prompt with no attachments or parts");
      }

      // Lifecycle option validation (Claude SDK semantics).
      if (callOpts?.forkSession && !callOpts.resume?.trim()) {
        throw new AgentError(
          "invalid_input",
          "options.forkSession requires options.resume (the source session id to fork from)",
        );
      }
      if (callOpts?.resumeSessionAt && !callOpts.resume?.trim()) {
        throw new AgentError("invalid_input", "options.resumeSessionAt requires options.resume");
      }
      if (callOpts?.sessionId?.trim() && callOpts?.resume?.trim()) {
        throw new AgentError(
          "invalid_input",
          "options.sessionId (pin a UUID for a new session) and options.resume are mutually exclusive",
        );
      }

      const { merged, cleanup } = mergeCallOpts(opts, callOpts);
      // Strip lifecycle fields before passing to the provider — providers see
      // only standard CallOptions; lifecycle is encoded in StreamOp.
      const {
        resume,
        resumeSessionAt,
        forkSession,
        sessionId: pinnedSessionId,
        ...providerOpts
      } = merged;

      let op: StreamOp;
      if (resume?.trim() && forkSession) {
        op = {
          kind: "fork",
          sourceSessionId: resume,
          prompt: promptText,
          ...(resumeSessionAt ? { atMessageId: resumeSessionAt } : {}),
        };
      } else if (resume?.trim()) {
        op = {
          kind: "resume",
          sessionId: resume,
          prompt: promptText,
          ...(resumeSessionAt ? { atMessageId: resumeSessionAt } : {}),
        };
      } else {
        op = {
          kind: "start",
          prompt: promptText,
          ...(pinnedSessionId?.trim() ? { pinnedSessionId } : {}),
        };
      }

      const stream = provider.stream(op, providerOpts);
      const result = createStreamResult(stream, provider.name, providerOpts.abortSignal);
      result.result.finally(cleanup).catch(() => {});
      return result;
    },

    async deleteSession(sessionId: string): Promise<void> {
      if (disposed) {
        throw new AgentError("internal", "Agent has been disposed");
      }
      if (!sessionId?.trim()) {
        throw new AgentError("invalid_input", "sessionId is required");
      }

      // Call provider's deleteSession if available
      if (provider.deleteSession) {
        await provider.deleteSession(sessionId);
      } else {
        // Provider doesn't support session deletion - no-op
      }
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await provider.dispose();
    },

    [Symbol.asyncDispose]() {
      return this.dispose();
    },
  };

  return agent;
}
