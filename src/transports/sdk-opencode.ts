import type {
  OpencodeConfig,
  ProviderImpl,
  StreamOp,
  CallOptions,
  AgentEvent,
  Attachment,
  ContentPart,
} from "../types.js";
import {
  sessionEvent,
  sessionForkedEvent,
  turnStartEvent,
  turnEndEvent,
  textDeltaEvent,
  thinkingDeltaEvent,
  resultEvent,
  errorEvent,
  rawEvent,
  permissionRequestEvent,
} from "../events.js";
import { AgentError, notSupported } from "../errors.js";
import { materializeAttachments, cleanupAttachments } from "../attachments.js";
import { spawnProcess, type SpawnedProcess } from "../runtime.js";
import { applySandbox } from "../sandbox/index.js";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2/client";

// Prompt `parts` accepted by SDK's session.promptAsync body.
// SDK signature: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>.
// We only generate text and file parts here (agent/subtask are niche).
type SdkPromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; filename?: string; url: string };

// SDK event types (simplified based on gen/types.gen.d.ts)
type SDKEvent = {
  type: string;
  properties: Record<string, unknown>;
};

/* Not needed - using type from SDK
interface OpencodeClient {
  session: {
    create(options?: { body?: { title?: string; directory?: string } }): Promise<{ data?: { id?: string } }>;
    promptAsync(options: {
      path: { id: string };
      body: {
        parts: Array<{ type: string; text?: string }>;
        model?: string | { providerID: string; modelID: string };
        agent?: string;
      };
    }): Promise<unknown>;
    fork(options: { path: { id: string } }): Promise<{ data?: { id?: string } }>;
  };
  event: {
    subscribe(options?: { query?: { directory?: string } }): Promise<{
      stream: AsyncGenerator<SDKEvent>;
    }>;
  };
}
*/

interface ServerProcess {
  port: number;
  url: string;
  process: SpawnedProcess;
}

/**
 * Create an Opencode provider using the @opencode-ai/sdk package.
 *
 * This transport:
 * - Lazily spawns `opencode serve --port <port>` on first stream() call
 * - Uses the SDK's HTTP/SSE client for session management and events
 * - Kills the spawned server process on dispose()
 */
export function createOpencodeSdkTransport(config?: OpencodeConfig): ProviderImpl {
  const cwd = config?.cwd ?? process.cwd();
  const binPath = config?.binPath ?? "opencode";

  let serverProcess: ServerProcess | undefined;
  let client: OpencodeClient | undefined;
  let sandboxCleanup: (() => Promise<void>) | undefined;
  // Shared promise used to serialize concurrent ensureServer() callers so
  // multiple stream() invocations don't race to spawn duplicate servers.
  let ensurePromise: Promise<{ client: OpencodeClient; cwd: string }> | null = null;

  // Per-transport flag to emit the "tools not supported" warning at most once
  // per transport instance (scoped to the closure — not module-level — so
  // separate agents don't silence each other).
  let toolsWarnOnce = false;

  async function ensureServer(): Promise<{ client: OpencodeClient; cwd: string }> {
    if (serverProcess && client) return { client, cwd };
    if (!ensurePromise) {
      ensurePromise = (async (): Promise<{ client: OpencodeClient; cwd: string }> => {
        // Re-check inside the critical section: a previous caller may have
        // populated serverProcess/client before we acquired this promise slot.
        if (serverProcess && client) return { client, cwd };

        // Strategy for port selection:
        //  - If caller specified serverPort, honor it (their risk).
        //  - Otherwise, spawn `opencode serve --port 0`: the server picks an
        //    OS-assigned free port atomically (no TOCTOU window between
        //    listing-a-port and spawning). We then parse the actual port from
        //    the server's stdout line: "opencode server listening on http://HOST:PORT".
        const explicitPort = config?.serverPort;
        const portArg = explicitPort ?? 0;

        const args = ["serve", "--hostname=127.0.0.1", `--port=${portArg}`];
        // Filter undefined values from process.env for the env record type.
        const envRecord: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string") envRecord[k] = v;
        }

        // Wrap the spawn with `nono run …` if a sandbox config was provided.
        // Caveat: the kit's HTTP control channel goes from the host process to
        // 127.0.0.1:<port> on the sandboxed server. Modes that block network
        // (e.g. `paranoid`) will sever that channel unless the user supplies a
        // profile with `--open-port <port>`. For the common "cwd" mode, network
        // is allowed, so the loopback HTTP works out of the box.
        let spawnCmd: string[] = [binPath, ...args];
        if (config?.sandbox) {
          const sandboxResult = await applySandbox(spawnCmd, cwd, config.sandbox);
          spawnCmd = sandboxResult.cmd;
          sandboxCleanup = sandboxResult.cleanup;
        }
        const [exec, ...execArgs] = spawnCmd;
        if (!exec) {
          throw new AgentError(
            "invalid_input",
            "opencode spawn command is empty after sandbox wrap",
          );
        }
        const proc = spawnProcess([exec, ...execArgs], {
          cwd,
          stdin: "ignore",
          stderr: "pipe",
          env: envRecord,
        });

        let resolvedPort: number | undefined = explicitPort;
        let resolvedUrl: string | undefined = explicitPort
          ? `http://127.0.0.1:${explicitPort}`
          : undefined;

        // If the server chose the port (port=0), parse it from stdout.
        if (!explicitPort) {
          try {
            resolvedUrl = await readServerUrlFromStdout(proc, 30_000);
            const m = resolvedUrl.match(/:(\d+)$/);
            resolvedPort = m ? Number(m[1]) : 0;
          } catch (err) {
            try {
              proc.kill();
            } catch {
              // ignore
            }
            throw err instanceof AgentError
              ? err
              : new AgentError(
                  "timeout",
                  `Opencode server failed to announce its port: ${err instanceof Error ? err.message : String(err)}`,
                );
          }
        }

        // Poll for server readiness (covers both explicit-port and parsed-port paths).
        const ready = await waitForServer(resolvedUrl!, 30_000);
        if (!ready) {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          throw new AgentError(
            "timeout",
            `Opencode server failed to start within 30s at ${resolvedUrl}`,
          );
        }

        serverProcess = { port: resolvedPort ?? 0, url: resolvedUrl!, process: proc };
        client = createOpencodeClient({ baseUrl: resolvedUrl!, directory: cwd });
        return { client, cwd };
      })().catch((err) => {
        // Reset on failure so the next caller can retry cleanly.
        ensurePromise = null;
        throw err;
      });
    }
    return ensurePromise;
  }

  return {
    name: "opencode",
    transport: "sdk",

    stream(op: StreamOp, opts: CallOptions): AsyncIterable<AgentEvent> {
      return streamOpencodeSdk(op, opts, {
        ensureServer,
        config,
        hasWarnedTools: () => toolsWarnOnce,
        markWarnedTools: () => {
          toolsWarnOnce = true;
        },
      });
    },

    async dispose() {
      if (serverProcess) {
        const proc = serverProcess.process;
        serverProcess = undefined;
        client = undefined;

        // Graceful shutdown: SIGTERM, then SIGKILL after 2s
        try {
          proc.kill();
          const timeout = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {
              // already dead
            }
          }, 2000);
          await proc.exited.finally(() => clearTimeout(timeout));
        } catch {
          // already dead
        }
      }
      if (sandboxCleanup) {
        try {
          await sandboxCleanup();
        } catch {
          // ignore cleanup errors (e.g. installed profile file already gone)
        }
        sandboxCleanup = undefined;
      }
    },

    async deleteSession(sessionId: string): Promise<void> {
      // Wire up SDK session.delete. Server is started lazily; if we don't have
      // a client yet, there is nothing meaningful to delete server-side.
      if (!client) {
        await ensureServer();
      }
      const c = client;
      if (!c) {
        throw notSupported(
          "OpenCode SDK transport unavailable for deleteSession",
          "delete_unavailable",
        );
      }
      try {
        const resp = await c.session.delete({ sessionID: sessionId, directory: cwd });
        const err = (resp as { error?: unknown }).error;
        if (err) {
          throw new AgentError(
            "not_found",
            `Failed to delete session ${sessionId}: ${typeof err === "string" ? err : JSON.stringify(err)}`,
            err,
          );
        }
      } catch (e) {
        if (e instanceof AgentError) throw e;
        throw new AgentError(
          "provider",
          `Failed to delete session ${sessionId}: ${e instanceof Error ? e.message : String(e)}`,
          undefined,
          undefined,
          e,
        );
      }
    },
  };
}

async function* streamOpencodeSdk(
  op: StreamOp,
  opts: CallOptions,
  ctx: {
    ensureServer: () => Promise<{ client: OpencodeClient; cwd: string }>;
    config?: OpencodeConfig;
    hasWarnedTools: () => boolean;
    markWarnedTools: () => void;
  },
): AsyncIterable<AgentEvent> {
  const { client, cwd } = await ctx.ensureServer();
  // Per-call `opts.model` wins over construction-time `config.model`.
  const modelStr = opts.model ?? ctx.config?.model ?? "github-copilot/gpt-4o";
  const agent = ctx.config?.agent;

  // Parse model string into {providerID, modelID} format
  // Model format is "providerID/modelID" or just "modelID"
  let model: { providerID: string; modelID: string };
  if (modelStr.includes("/")) {
    const parts = modelStr.split("/", 2);
    const providerID = parts[0] ?? "github-copilot";
    const modelID = parts[1] ?? "gpt-4o";
    model = { providerID, modelID };
  } else {
    // If no provider, assume github-copilot
    model = { providerID: "github-copilot", modelID: modelStr };
  }

  let sessionId: string;

  // Handle start/resume/fork operations. StreamOp is a discriminated union;
  // an exhaustive switch on `op.kind` lets TS narrow each arm and ensures
  // any future variant breaks the build instead of silently falling through.
  switch (op.kind) {
    case "start": {
      // The opencode SDK does not expose a way to pin a caller-supplied
      // session id on create — `SessionCreateData.body` only accepts
      // `parentID` and `title`; the server assigns the id. Reject explicitly
      // so callers don't silently get a different id than they passed.
      if (op.pinnedSessionId) {
        throw notSupported(
          "opencode SDK does not support options.sessionId (pinning a UUID for a new session); the server assigns the session id.",
          "pinned_session_id_unsupported",
        );
      }
      // TODO: opencode SDK does not currently expose user-facing custom-tool
      // registration. `SessionCreateData.body` only accepts `parentID` and
      // `title`; `SessionPromptAsyncData.body.tools` is a `Record<string, boolean>`
      // enable/disable toggle over built-in tool IDs, not a place to register
      // caller-defined tool handlers with schemas. The only related SDK
      // surface is read-only: `client.tool.ids()` / `client.tool.list()`
      // (GET /experimental/tool[/ids]). If/when the SDK adds a tool-register
      // endpoint, convert `opts.tools` (Record<string, AgentTool>) into the
      // SDK shape and pass it here.
      if (opts.tools && Object.keys(opts.tools).length > 0 && !ctx.hasWarnedTools()) {
        ctx.markWarnedTools();
        console.warn(
          "[agent-sdk] opencode SDK does not currently expose custom-tool registration; tools will be ignored",
        );
      }
      const createResp = await client.session.create(
        { directory: cwd },
        { signal: opts.abortSignal },
      );
      sessionId = createResp.data?.id ?? "";
      if (!sessionId) {
        throw new AgentError("provider", "Opencode SDK failed to return a session ID on create");
      }
      yield sessionEvent(sessionId);
      break;
    }
    case "resume": {
      if (!op.sessionId) {
        throw new AgentError("invalid_input", "Resume operation requires sessionId");
      }
      sessionId = op.sessionId;
      // In-place rewind: revert the session to the given message before
      // sending the new prompt. opencode exposes
      // `POST /session/{id}/revert` with `body.messageID` (see
      // @opencode-ai/sdk SessionRevertData) which truncates the session at
      // that message in place — same session id is preserved.
      if (op.atMessageId) {
        await client.session.revert(
          { sessionID: sessionId, messageID: op.atMessageId, directory: cwd },
          { signal: opts.abortSignal },
        );
      }
      break;
    }
    case "fork": {
      if (!op.sourceSessionId) {
        throw new AgentError("invalid_input", "Fork operation requires sourceSessionId");
      }
      // Fork-at-message: opencode SDK exposes `body.messageID` on
      // POST /session/{id}/fork (see @opencode-ai/sdk SessionForkData).
      // When omitted, the fork branches from the end of the source.
      const forkResp = await client.session.fork(
        {
          sessionID: op.sourceSessionId,
          directory: cwd,
          ...(op.atMessageId ? { messageID: op.atMessageId } : {}),
        },
        { signal: opts.abortSignal },
      );
      sessionId = forkResp.data?.id ?? "";
      if (!sessionId) {
        throw new AgentError("provider", "Opencode SDK failed to return a session ID on fork");
      }
      yield sessionForkedEvent(sessionId, op.sourceSessionId);
      break;
    }
    default: {
      // Exhaustiveness assertion: if a new StreamOp variant is added, this
      // line will fail to compile, forcing the switch to be updated.
      const _exhaustive: never = op;
      throw new AgentError(
        "invalid_input",
        `Unknown operation kind: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }

  // Build prompt parts: text + attachments + pass-through ContentPart.
  // Any materialized temp files are cleaned up after the stream finishes.
  const { parts: promptParts, cleanup: cleanupParts } = await buildPromptParts(
    op.prompt,
    opts.attachments,
    opts.parts,
    opts.abortSignal,
  );

  // Subscribe to events BEFORE calling promptAsync (race-safe).
  // NOTE: The OpenCode SDK does not expose a per-request correlation/request
  // ID on either `event.subscribe` or `session.promptAsync`. We therefore
  // filter the global event stream by the session ID we just created/resumed,
  // which is unique to this stream call. If the SDK ever adds a correlationId
  // or requestId field, prefer that for stricter filtering. (TODO)
  const subscribeResp = await client.event.subscribe(
    { directory: cwd },
    { signal: opts.abortSignal },
  );
  const eventStream = subscribeResp.stream;

  // Wire AbortSignal -> SDK session.abort + terminate event loop.
  // We track cleanup so the listener is removed when the stream finishes
  // naturally (not just on abort).
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    // Best-effort: tell the server to abort the session. Failures are ignored;
    // we still terminate the local for-await loop via the `aborted` flag.
    client.session.abort({ sessionID: sessionId, directory: cwd }).catch(() => {});
    // Force the event stream generator to terminate promptly.
    try {
      eventStream.return?.(undefined);
    } catch {
      // ignore
    }
  };
  let abortListenerAttached = false;
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) {
      onAbort();
    } else {
      opts.abortSignal.addEventListener("abort", onAbort, { once: true });
      abortListenerAttached = true;
    }
  }

  try {
    // Start processing events in parallel
    const eventPromise = processEvents(eventStream, sessionId, () => aborted, {
      client,
      cwd,
      onPermissionRequest: opts.onPermissionRequest,
    });

    // Send the prompt. The SDK's promptAsync body accepts an optional `system`
    // string (see @opencode-ai/sdk types.gen.d.ts: SessionPromptAsyncData.body).
    // Map opts.systemPrompt / opts.appendSystemPrompt onto it; the SDK has no
    // distinction between replace/append, so both flow into the same field.
    const systemPrompt = opts.systemPrompt ?? opts.appendSystemPrompt;
    try {
      await client.session.promptAsync(
        {
          sessionID: sessionId,
          directory: cwd,
          // SDK accepts TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput.
          // We only produce text + file parts; the cast is safe (structural match).
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          parts: promptParts as any,
          model,
          agent,
          ...(systemPrompt ? { system: systemPrompt } : {}),
        },
        { signal: opts.abortSignal },
      );
    } catch (err) {
      // Emit error event but continue reading events
      const message = err instanceof Error ? err.message : String(err);
      yield errorEvent(message, "provider", err);
    }

    // Yield all events from the event stream
    yield* eventPromise;
  } finally {
    // Remove the abort listener regardless of how we exit (promptAsync throw,
    // eventPromise throw, early .return() from consumer, or normal completion).
    if (abortListenerAttached && opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", onAbort);
    }
    // Cleanup any materialized temp files (images/resources).
    await cleanupParts();
  }
}

async function* processEvents(
  eventStream: AsyncGenerator<SDKEvent>,
  sessionId: string,
  isAborted: () => boolean = () => false,
  ctx?: {
    client: OpencodeClient;
    cwd: string;
    onPermissionRequest?: CallOptions["onPermissionRequest"];
  },
): AsyncIterable<AgentEvent> {
  let accumulatedText = "";
  let previousText = "";
  let previousReasoning = "";
  let lastRaw: unknown;
  let lastStopReason: string | undefined;
  let stepFinishSeen = false;

  try {
    for await (const event of eventStream) {
      if (isAborted()) break;
      const props = event.properties;
      const eventType = event.type;

      // Emit raw event for debugging
      yield rawEvent("opencode", event);

      // Filter by sessionID
      const eventSessionId = getSessionId(props);
      if (eventSessionId && eventSessionId !== sessionId) {
        continue; // skip events from other sessions
      }

      lastRaw = event;

      switch (eventType) {
        case "message.part.updated": {
          const part = props.part as Record<string, unknown> | undefined;
          const partType = part?.type as string | undefined;
          const partSessionId = part?.sessionID as string | undefined;

          if (partSessionId !== sessionId) {
            continue; // skip parts from other sessions
          }

          if (!part) continue;

          if (partType === "text") {
            const text = part.text as string | undefined;
            if (text) {
              // Compute delta
              const delta = text.slice(previousText.length);
              if (delta.length > 0) {
                accumulatedText += delta;
                previousText = text;
                yield textDeltaEvent(delta, part.messageID as string | undefined);
              }
            }
          } else if (partType === "reasoning" || partType === "thinking") {
            // OpenCode SDK ReasoningPart: { type: "reasoning", text, ... }
            const text = part.text as string | undefined;
            if (text) {
              const delta = text.slice(previousReasoning.length);
              if (delta.length > 0) {
                previousReasoning = text;
                yield thinkingDeltaEvent(delta, part.messageID as string | undefined);
              }
            }
          } else if (partType === "step-start") {
            yield turnStartEvent();
          } else if (partType === "step-finish") {
            const reason = (part.reason as string) ?? "stop";
            lastStopReason = mapStopReason(reason);

            // Emit usage
            const tokens = part.tokens as Record<string, unknown> | undefined;
            if (tokens) {
              const cache = tokens.cache as Record<string, unknown> | undefined;
              yield {
                type: "usage",
                inputTokens: (tokens.input as number) ?? undefined,
                outputTokens: (tokens.output as number) ?? undefined,
                thoughtTokens: (tokens.reasoning as number) ?? undefined,
                cachedReadTokens: (cache?.read as number) ?? undefined,
                cachedWriteTokens: (cache?.write as number) ?? undefined,
                costUsd: (part.cost as number) ?? undefined,
              };
            }

            yield turnEndEvent(lastStopReason);
            stepFinishSeen = true;
            // After step-finish, we're done - emit result and exit
            yield resultEvent(sessionId, accumulatedText, lastRaw);
            return;
          } else if (partType === "tool") {
            const tool = part.tool as string | undefined;
            const callID = part.callID as string | undefined;
            const state = part.state as Record<string, unknown> | undefined;
            const stateType = state?.type as string | undefined;

            if (stateType === "pending" || stateType === "running") {
              const args = (state as Record<string, unknown>)?.args as unknown;
              yield {
                type: "tool_call",
                callId: callID ?? "",
                name: tool ?? "",
                input: args ?? {},
                status: stateType === "pending" ? "pending" : "in_progress",
              };
            } else if (stateType === "completed" || stateType === "error") {
              const output = (state as Record<string, unknown>)?.output as unknown;
              yield {
                type: "tool_result",
                callId: callID ?? "",
                output: output ?? "",
                isError: stateType === "error",
                status: stateType === "error" ? "failed" : "completed",
              };
            }
          }
          break;
        }

        case "session.idle": {
          // Session is idle, stream is done (only if we've seen step-finish)
          if (stepFinishSeen) {
            yield resultEvent(sessionId, accumulatedText, lastRaw);
            return;
          }
          break;
        }

        case "session.error": {
          const errorSessionId = props.sessionID as string | undefined;
          // Handle errors for our session
          if (errorSessionId === sessionId) {
            const error = props.error as Record<string, unknown> | undefined;
            const errorData = error?.data as Record<string, unknown> | undefined;
            const message = errorData?.message as string | undefined;
            const errorMessage = message ?? (error?.name as string) ?? "Unknown opencode error";
            const code = error?.name as string | undefined;
            yield errorEvent(errorMessage, code, event);
            // Don't exit immediately - wait for session.idle to confirm completion
            stepFinishSeen = true; // Mark as finished so session.idle will exit
          }
          break;
        }

        case "session.status": {
          const status = props.status as string | undefined;
          if ((status === "idle" || status === "completed") && stepFinishSeen) {
            // Session finished
            yield resultEvent(sessionId, accumulatedText, lastRaw);
            return;
          }
          break;
        }

        case "permission.asked": {
          // v2 PermissionRequest shape: { id, sessionID, permission, patterns,
          // metadata, always, tool? }. We forward as a permission_request event,
          // and — if the caller supplied onPermissionRequest — post the decision
          // back via client.permission.reply({ requestID, reply }).
          const permSessionId = props.sessionID as string | undefined;
          if (permSessionId && permSessionId !== sessionId) break;
          const permId = props.id as string | undefined;
          const permName = (props.permission as string | undefined) ?? "permission_request";
          const permType = (props.permission as string | undefined) ?? "unknown";
          if (!permId) break;

          // Build a respond() callback that hits the SDK endpoint. It's a
          // best-effort call; failures are swallowed so the stream keeps going.
          const client = ctx?.client;
          const cwd = ctx?.cwd;
          const respond = client
            ? async (decision: "allow" | "deny", respOpts?: { persist?: boolean }) => {
                const reply: "once" | "always" | "reject" =
                  decision === "deny" ? "reject" : respOpts?.persist ? "always" : "once";
                try {
                  // v2 SDK: client.permission.reply({ requestID, reply, directory }).
                  // Replaces v1's auto-named postSessionIdPermissionsPermissionId.
                  await client.permission.reply({
                    requestID: permId,
                    reply,
                    ...(cwd ? { directory: cwd } : {}),
                  });
                } catch {
                  // ignore — caller sees no ack, permission system is best-effort
                }
              }
            : undefined;

          yield permissionRequestEvent(permId, permType, event, {
            annotations: { justification: permName },
            respond,
          });

          // If the caller provided an onPermissionRequest handler, invoke it and
          // auto-respond. We still emit the event above so observers can see it.
          const handler = ctx?.onPermissionRequest;
          if (handler && respond) {
            try {
              const decision = await handler({
                requestId: permId,
                toolName: permType,
                details: event,
                annotations: { justification: permName },
              });
              if (decision.decision === "allow") {
                await respond("allow", { persist: decision.persist });
              } else {
                await respond("deny");
              }
            } catch (err) {
              // Emit error but continue — the server will time out the permission
              const msg = err instanceof Error ? err.message : String(err);
              yield errorEvent(`permission handler failed: ${msg}`, "provider", err);
            }
          }
          break;
        }

        default:
          // Ignore other event types.
          //
          // NOTE on events NOT present in @opencode-ai/sdk:
          //  - No `agent_thought_chunk` event; reasoning is delivered via
          //    `message.part.updated` with part.type === "reasoning" (handled above).
          //  - No `usage_update` event; token usage is emitted as part of the
          //    `step-finish` message part (handled above).
          //  - No `available_commands_update` event. `command.executed` exists
          //    but represents a single command invocation, not a catalogue.
          //    Catalog discovery is a request/response via client.command.list().
          // TODO: if future SDK versions add these events, forward them via
          // thinkingDeltaEvent / usageEvent / availableCommandsEvent respectively.
          break;
      }
    }

    // Stream ended, emit final result
    yield resultEvent(sessionId, accumulatedText, lastRaw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield errorEvent(message, "provider", err);
    yield resultEvent(sessionId, accumulatedText, lastRaw);
  }
}

function getSessionId(props: Record<string, unknown>): string | undefined {
  if (props.sessionID) return props.sessionID as string;
  const part = props.part as Record<string, unknown> | undefined;
  if (part?.sessionID) return part.sessionID as string;
  return undefined;
}

function mapStopReason(reason: string | undefined): string {
  switch (reason) {
    case "stop":
    case "end_turn":
      return "end_turn";
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "cancelled":
      return "cancelled";
    default:
      return reason ?? "end_turn";
  }
}

/**
 * Read the announce line from `opencode serve`'s stdout and return the full
 * http://host:port URL. The server prints "opencode server listening on <URL>"
 * once it has bound. We also scan stderr as a fallback because log output can
 * be routed there depending on flags.
 *
 * With --port=0 the server asks the OS for a free port atomically, eliminating
 * the TOCTOU race that would occur if we pre-allocated a port ourselves.
 */
async function readServerUrlFromStdout(proc: SpawnedProcess, timeoutMs: number): Promise<string> {
  const pattern = /listening on\s+(https?:\/\/\S+)/i;
  const deadline = Date.now() + timeoutMs;

  const scan = async (stream: ReadableStream<Uint8Array> | undefined): Promise<string> => {
    if (!stream) return "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const m = buf.match(pattern);
        if (m && m[1]) return m[1].replace(/[.,;]+$/, "");
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    return "";
  };

  // Race stdout and stderr; whichever yields the URL first wins.
  const results = await Promise.race([
    scan(proc.stdout),
    scan(proc.stderr),
    new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new AgentError("timeout", "timed out waiting for opencode serve URL")),
        timeoutMs,
      ),
    ),
  ]);

  if (!results) {
    throw new AgentError("timeout", "opencode serve exited before announcing a port");
  }
  return results;
}

/**
 * Build SDK prompt parts from the text prompt plus any caller-provided
 * attachments and pre-built ContentParts.
 *
 * Mapping to opencode SDK types (TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput):
 *  - attachments `{type:"file", path}` → FilePartInput `{ type:"file", mime, filename, url: "file://…" }`
 *  - attachments `{type:"image", data, mimeType}` → materialized to temp file, sent as FilePartInput with file:// URL
 *  - attachments `{type:"image_url", url}` → fetched by materializeAttachments, sent as FilePartInput
 *  - attachments `{type:"resource", name, content, mimeType}` → sent as a TextPartInput containing the pasted content
 *  - opts.parts (ContentPart):
 *       text           → TextPartInput
 *       image          → data: URL FilePartInput
 *       resource       → TextPartInput (text content pasted if present)
 *       resource_link  → FilePartInput if uri is file:// or http(s); skipped otherwise with warn
 *       audio          → skipped with console.warn (SDK has no audio part)
 *       unknown types  → skipped with console.warn
 *
 * Returns the parts array plus a cleanup() that unlinks any temp files.
 * Individual part failures are caught and logged via console.warn rather
 * than aborting the whole prompt.
 */
async function buildPromptParts(
  prompt: string,
  attachments: Attachment[] | undefined,
  parts: ContentPart[] | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<{ parts: SdkPromptPart[]; cleanup: () => Promise<void> }> {
  const out: SdkPromptPart[] = [{ type: "text", text: prompt }];
  const materialized = attachments?.length
    ? await materializeAttachments(attachments, abortSignal)
    : [];

  // Map each materialized attachment into an SDK part. materializeAttachments
  // preserves the original type via `origType`, so we know which kind it came
  // from (file vs image vs image_url vs resource).
  for (const mat of materialized) {
    try {
      if (mat.origType === "resource") {
        // `resource` attachments are pasted textual content. Read the
        // materialized temp file and inline it as a text part so models can
        // see it without a file fetch.
        const fs = await import("node:fs/promises");
        const text = await fs.readFile(mat.path, "utf-8");
        out.push({ type: "text", text });
      } else {
        // file / image / image_url all become FilePartInput with a file:// URL.
        const filename = mat.path.split(/[\\/]/).pop() ?? undefined;
        out.push({
          type: "file",
          mime: mat.mimeType ?? guessMimeFromPath(mat.path),
          filename,
          url: `file://${mat.path}`,
        });
      }
    } catch (err) {
      console.warn("agent-sdk: failed to convert attachment to prompt part", err);
    }
  }

  // Pass-through ContentPart (ACP shapes). We convert what we can and skip
  // the rest defensively.
  if (parts) {
    for (const p of parts) {
      try {
        const maybe = contentPartToSdkPart(p);
        if (maybe) out.push(maybe);
      } catch (err) {
        console.warn("agent-sdk: failed to convert ContentPart", p, err);
      }
    }
  }

  return {
    parts: out,
    cleanup: () => cleanupAttachments(materialized),
  };
}

/** Convert an ACP ContentPart into an SDK prompt part, or null to skip. */
function contentPartToSdkPart(p: ContentPart): SdkPromptPart | null {
  switch (p.type) {
    case "text": {
      const text = (p as { type: "text"; text: string }).text;
      return { type: "text", text };
    }
    case "image": {
      // Base64 data → inline data: URL as a FilePartInput.
      const { data, mimeType } = p as { type: "image"; data: string; mimeType: string };
      return { type: "file", mime: mimeType, url: `data:${mimeType};base64,${data}` };
    }
    case "audio": {
      console.warn("agent-sdk: opencode SDK has no audio part; skipping");
      return null;
    }
    case "resource_link": {
      const { uri, name, mimeType } = p as {
        type: "resource_link";
        uri: string;
        name?: string;
        mimeType?: string;
      };
      // Only forward URIs the server can fetch: file://, http(s)://, data:.
      if (/^(file|https?|data):/i.test(uri)) {
        return {
          type: "file",
          mime: mimeType ?? "application/octet-stream",
          filename: name,
          url: uri,
        };
      }
      console.warn(`agent-sdk: resource_link with unsupported scheme skipped: ${uri}`);
      return null;
    }
    case "resource": {
      const { resource } = p as {
        type: "resource";
        resource: { uri: string; mimeType?: string; text?: string };
      };
      // Prefer inlined text when present (matches MCP's embedded-resource convention).
      if (resource.text != null) return { type: "text", text: resource.text };
      if (/^(file|https?|data):/i.test(resource.uri)) {
        return {
          type: "file",
          mime: resource.mimeType ?? "application/octet-stream",
          url: resource.uri,
        };
      }
      console.warn(`agent-sdk: resource without text and unsupported URI skipped: ${resource.uri}`);
      return null;
    }
    default:
      // Unknown/extension part type: skip defensively.
      console.warn(`agent-sdk: skipping ContentPart of unsupported type: ${p.type}`);
      return null;
  }
}

function guessMimeFromPath(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url, { method: "GET" });
      if (resp.ok || resp.status === 404) {
        // Server is responding (404 is fine, just means the root path isn't handled)
        return true;
      }
    } catch {
      // Connection refused, server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
