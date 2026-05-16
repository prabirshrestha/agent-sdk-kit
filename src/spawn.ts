import { AgentError } from "./errors.js";
import { spawnProcess } from "./runtime.js";

export interface SpawnOptions {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface SpawnResult {
  lines: AsyncIterable<unknown>;
  /** Captured stderr as a single string, resolved once the process exits. */
  stderr: Promise<string>;
  process: { pid: number; kill: () => void; exitCode: Promise<number> };
}

/**
 * Spawn a subprocess and yield parsed JSONL lines from stdout.
 */
export async function spawnJsonl(opts: SpawnOptions): Promise<SpawnResult> {
  if (opts.abortSignal?.aborted) {
    throw new AgentError("aborted", "Spawn aborted before start");
  }

  const proc = spawnProcess(opts.cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stderr: "pipe",
  });

  if (!proc.stdout) {
    throw new AgentError("internal", "Failed to capture stdout from subprocess");
  }

  const abortHandler = () => {
    try {
      proc.kill();
    } catch {
      // process may already be dead
    }
  };

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", abortHandler, { once: true });
  }

  const exitCodePromise = proc.exited.finally(() => {
    if (opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", abortHandler);
    }
  });

  const lines = parseJsonlStream(proc.stdout, opts.abortSignal);

  // Drain stderr into a single string. Resolves when the stream closes.
  const stderrPromise: Promise<string> = proc.stderr
    ? new Response(proc.stderr).text().catch(() => "")
    : Promise.resolve("");

  return {
    lines,
    stderr: stderrPromise,
    process: {
      pid: proc.pid ?? -1,
      kill: () => {
        try {
          proc.kill();
        } catch {
          // already dead
        }
      },
      exitCode: exitCodePromise,
    },
  };
}

/**
 * Parse a JSONL stream from a ReadableStream<Uint8Array>.
 *
 * Handles:
 * - Lines split across chunks
 * - Multi-byte UTF-8 characters split across chunks
 * - Trailing newlines
 * - Empty lines (skipped)
 * - Non-JSON output lines (skipped with console.warn)
 */
export async function* parseJsonlStream(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncIterable<unknown> {
  const decoder = new TextDecoder("utf-8");
  const reader = stream.getReader();
  let buffer = "";

  // Capture as const so cleanup is unambiguous. {once:true} auto-removes on
  // fire; the finally-block removeEventListener is a no-op in that case.
  const abortListener: (() => void) | undefined = abortSignal
    ? () => {
        // Best-effort cancel; ignore errors (reader may already be released or
        // the stream already in an errored state).
        reader.cancel().catch(() => {});
      }
    : undefined;
  if (abortSignal && abortListener) {
    abortSignal.addEventListener("abort", abortListener, { once: true });
  }

  try {
    while (true) {
      if (abortSignal?.aborted) {
        break;
      }

      const { done, value } = await reader.read();

      if (done) {
        // Process any remaining data in the buffer
        if (buffer.length > 0) {
          const trimmed = buffer.trim();
          if (trimmed.length > 0) {
            try {
              yield JSON.parse(trimmed);
            } catch {
              console.warn("[agent-sdk] Non-JSON line from subprocess (final):", trimmed);
            }
          }
        }
        break;
      }

      // Decode chunk, streaming: true handles multi-byte splits
      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }

        try {
          yield JSON.parse(trimmed);
        } catch {
          console.warn("[agent-sdk] Non-JSON line from subprocess:", trimmed);
        }
      }
    }
  } finally {
    if (abortSignal && abortListener) {
      // Unconditional removal — no-op if {once:true} already removed it.
      abortSignal.removeEventListener("abort", abortListener);
    }
    try {
      reader.releaseLock();
    } catch (err) {
      // Swallow harmless "lock already released / not held" races. The exact
      // wording differs across runtimes:
      //   - Bun:    "ReadableStreamDefaultReader: released"
      //   - Node:   "Cannot release a lock on a reader that is not held"
      //   - Spec:   includes the word "released"
      const msg = err instanceof Error ? err.message : String(err);
      const isReleaseRace = /released|not\s+held|no\s+longer/i.test(msg);
      if (!isReleaseRace) {
        // Unrelated error: re-surface via console (we can't throw from finally
        // without masking the iterator's own outcome).
        console.warn("[agent-sdk] reader.releaseLock() error:", err);
      }
    }
  }
}
