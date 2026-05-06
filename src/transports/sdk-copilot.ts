import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  CopilotConfig,
  ProviderImpl,
  StreamOp,
  CallOptions,
  AgentEvent,
  AgentTool,
} from "../types.js";
import { AgentError, notSupported } from "../errors.js";
import { which } from "../runtime.js";
import { applySandbox } from "../sandbox/index.js";
import {
  isPrivateOrLoopbackHost,
  IMAGE_URL_FETCH_TIMEOUT_MS,
  IMAGE_URL_MAX_BODY_BYTES,
} from "../attachments.js";
import {
  sessionEvent,
  sessionForkedEvent,
  turnStartEvent,
  turnEndEvent,
  textDeltaEvent,
  toolCallEvent,
  toolResultEvent,
  toolProgressEvent,
  resultEvent,
  rawEvent,
  errorEvent,
  permissionRequestEvent,
  withMeta,
} from "../events.js";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type {
  CopilotSession,
  SessionEvent,
  Tool,
  PermissionHandler,
  PermissionRequest as SdkPermissionRequest,
  PermissionRequestResult,
  SystemMessageConfig,
} from "@github/copilot-sdk";

// Map agent-sdk-kit's two prompt slots onto the Copilot SDK's
// SystemMessageConfig. The SDK supports three modes — append (keep CLI
// foundation + extra content), replace (caller-provided full prompt, drops
// SDK guardrails), and customize (section overrides). We use:
//   - opts.systemPrompt           -> mode: "replace"
//   - opts.appendSystemPrompt     -> mode: "append"
//   - both set                    -> "replace" with the appendSystemPrompt
//                                    concatenated (the SDK only accepts one
//                                    systemMessage per session, so combining
//                                    is the only way to honor both inputs).
// See @github/copilot-sdk/dist/types.d.ts SystemMessageConfig.
function buildCopilotSystemMessage(
  systemPrompt: string | undefined,
  appendSystemPrompt: string | undefined,
): SystemMessageConfig | undefined {
  if (systemPrompt && appendSystemPrompt) {
    return {
      mode: "replace",
      content: `${systemPrompt}\n\n${appendSystemPrompt}`,
    };
  }
  if (systemPrompt) {
    return { mode: "replace", content: systemPrompt };
  }
  if (appendSystemPrompt) {
    return { mode: "append", content: appendSystemPrompt };
  }
  return undefined;
}

interface CreateTransportOptions extends CopilotConfig {
  tools?: Record<string, AgentTool>;
}

interface SandboxedCliOpts {
  cliPath: string | undefined;
  cliArgs: string[] | undefined;
  cleanup?: () => Promise<void>;
}

// Build the (cliPath, cliArgs) pair to pass to CopilotClient when sandbox is
// configured. The Copilot SDK spawns its CLI as a subprocess (see
// github/copilot-sdk nodejs/src/client.ts:1455-1471) and exposes
// `cliPath` + `cliArgs` (inserted before SDK-managed args). We exploit those
// hooks to inject `nono run …` as the wrapper:
//
//   spawn(<nono-abs>, ["run", ...flags, "--", <copilot-bin>,
//                       <SDK args: --headless --no-auto-update …>])
//
// Caveats / preconditions:
// - The SDK validates `existsSync(cliPath)` before spawning (client.ts:1444),
//   so we must resolve `nono` to an absolute path via PATH lookup.
// - The user MUST pass an explicit `binPath` for the inner CLI when sandbox
//   is configured — we need a real path on disk to hand to nono.
// - If the inner `binPath` ends with `.js`, nono won't node-wrap it
//   (the SDK's auto-node logic only fires when *its* cliPath ends in `.js`),
//   so we prepend `process.execPath`.
async function buildSandboxedCopilotCliOpts(
  binPath: string | undefined,
  cwd: string,
  sandbox: CopilotConfig["sandbox"],
): Promise<SandboxedCliOpts> {
  if (!sandbox || !sandbox.mode || sandbox.mode === "none") {
    return { cliPath: binPath, cliArgs: undefined };
  }
  if (!binPath) {
    throw new AgentError(
      "invalid_input",
      "copilot({ sandbox }) requires an explicit binPath — the bundled CLI lookup is internal to @github/copilot-sdk and cannot be wrapped with nono without a real path.",
    );
  }

  const innerCmd = binPath.endsWith(".js") ? [process.execPath, binPath] : [binPath];
  const wrapped = await applySandbox(innerCmd, cwd, sandbox);
  if (!wrapped.applied) {
    // Sandbox couldn't be applied (e.g. nono missing, macOS nesting) — fall
    // back to unsandboxed and let the SDK spawn the CLI directly.
    return { cliPath: binPath, cliArgs: undefined, cleanup: wrapped.cleanup };
  }

  // wrapped.cmd is [nonoBinPath, "run", ...flags, "--", ...innerCmd]
  const [nonoBin, ...rest] = wrapped.cmd;
  if (!nonoBin) {
    throw new AgentError("internal", "applySandbox returned an empty command");
  }
  // The SDK calls existsSync(cliPath) — we need an absolute path.
  let nonoAbs = nonoBin;
  if (!isAbsolute(nonoAbs)) {
    const resolved = await which(nonoAbs);
    if (!resolved) {
      throw new AgentError(
        "internal",
        `Sandbox enabled but nono binary "${nonoAbs}" could not be resolved on PATH`,
      );
    }
    nonoAbs = resolved;
  }
  return { cliPath: nonoAbs, cliArgs: rest, cleanup: wrapped.cleanup };
}

export function createCopilotSdkTransport(config?: CreateTransportOptions): ProviderImpl {
  const cwd = config?.cwd ?? process.cwd();
  const binPath = config?.binPath;
  const tools = config?.tools;

  function convertToolsToSdk(
    agentTools: Record<string, AgentTool> | undefined,
    outerAbortSignal?: AbortSignal,
    emitToolProgress?: (callId: string, name: string, update: unknown) => void,
  ): Tool[] | undefined {
    if (!agentTools) return undefined;

    return Object.values(agentTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown>,
      handler: async (args: unknown, invocation: { sessionId: string; toolCallId: string }) => {
        try {
          const result = await tool.execute(args, {
            sessionId: invocation.sessionId,
            abortSignal: outerAbortSignal ?? new AbortController().signal,
            emit: emitToolProgress
              ? (update: unknown) => emitToolProgress(invocation.toolCallId, tool.name, update)
              : undefined,
          });
          return result;
        } catch (err) {
          return {
            textResultForLlm: err instanceof Error ? err.message : String(err),
            resultType: "failure" as const,
          };
        }
      },
    }));
  }

  async function* streamImpl(op: StreamOp, opts: CallOptions): AsyncIterable<AgentEvent> {
    let client: CopilotClient | null = null;
    let session: CopilotSession | null = null;
    let abortListener: (() => void) | undefined;
    let sandboxCleanup: (() => Promise<void>) | undefined;

    // Use an async queue to properly stream events from callbacks.
    // Entries are either raw SDK SessionEvents (to be normalized) or
    // pre-built AgentEvents (e.g., permission_request surfaced from the
    // SDK's onPermissionRequest callback so iterators see them on-stream).
    type QueueItem =
      | { kind: "sdk"; event: SessionEvent }
      | { kind: "agent"; event: AgentEvent }
      | { kind: "done" }
      | { kind: "error"; error: Error };
    const eventQueue: QueueItem[] = [];
    let queueResolve: (() => void) | undefined = undefined;
    const queuePromise = () =>
      new Promise<void>((resolve) => {
        queueResolve = resolve;
      });
    const notifyQueue = () => {
      const resolver = queueResolve;
      if (resolver) {
        queueResolve = undefined;
        resolver();
      }
    };

    // Emit callback for tool_progress events from async-generator tools.
    // Tools that yield intermediate updates via ctx.emit are surfaced here as
    // tool_progress AgentEvents pushed onto the stream's event queue.
    const emitToolProgress = (callId: string, name: string, update: unknown): void => {
      eventQueue.push({
        kind: "agent",
        event: toolProgressEvent(callId, name, update),
      });
      notifyQueue();
    };

    // Wrap the user's onPermissionRequest so we also emit a
    // `permission_request` AgentEvent to the stream before invoking the
    // callback. This ensures iterator-based consumers observe the request
    // even when a user callback is provided.
    //
    // TODO(persist): PermissionDecision.persist (src/types.ts) is currently
    // dropped on this path. The @github/copilot-sdk PermissionDecision type
    // (tmp/copilot-sdk/nodejs/src/generated/rpc.ts:79 — only `kind:
    // "approved"` plus several denial variants) has no always/remember/scope
    // field, so there is nowhere to plumb `persist` at this time. When the
    // SDK adds an "approved-always"-style kind or a separate scope field,
    // wire it here and update the docstring on PermissionDecision.persist.
    const userPermissionHandler = opts.onPermissionRequest as PermissionHandler | undefined;
    const permissionHandler: PermissionHandler = async (
      request: SdkPermissionRequest,
      invocation: { sessionId: string },
    ): Promise<PermissionRequestResult> => {
      const sdkReq = request as SdkPermissionRequest & { toolCallId?: string; kind?: string };
      const requestId = sdkReq.toolCallId ?? randomUUID();
      const toolName = sdkReq.kind ?? "unknown";
      eventQueue.push({
        kind: "agent",
        event: permissionRequestEvent(requestId, toolName, request),
      });
      notifyQueue();

      const handler = userPermissionHandler ?? approveAll;
      return await handler(request, invocation);
    };

    try {
      const sandboxed = await buildSandboxedCopilotCliOpts(binPath, cwd, config?.sandbox);
      sandboxCleanup = sandboxed.cleanup;

      // Create and start client
      client = new CopilotClient({
        cliPath: sandboxed.cliPath,
        ...(sandboxed.cliArgs ? { cliArgs: sandboxed.cliArgs } : {}),
        cwd,
        logLevel: "error",
        // Forward githubToken to the SDK when provided. The SDK accepts it as
        // a top-level option on CopilotClientOptions (see
        // tmp/copilot-sdk/nodejs/src/types.ts: `githubToken?: string`).
        ...(config?.githubToken ? { githubToken: config.githubToken } : {}),
      });

      await client.start();

      // Per-call `opts.model` wins over construction-time `config.model`.
      // SessionConfig.model is honored on createSession + resumeSession; passing
      // it on resume effectively switches the model for the upcoming turn.
      const resolvedModel = opts.model ?? config?.model;

      let sessionId: string;
      let pendingSessionForkedSourceId: string | undefined;

      // Shared SDK event handler — passed via `onEvent` in SessionConfig so it
      // is registered before the session.create / session.resume RPC fires
      // (see @github/copilot-sdk/dist/client.js where session.on(config.onEvent)
      // runs before the connection.sendRequest). This avoids losing any early
      // lifecycle events that the CLI emits during session creation.
      const onSdkEvent = (event: SessionEvent): void => {
        eventQueue.push({ kind: "sdk", event });
        notifyQueue();
        if (event.type === "session.idle") {
          eventQueue.push({ kind: "done" });
          notifyQueue();
        }
      };

      if (op.kind === "resume") {
        if (!op.sessionId) {
          throw new AgentError("invalid_input", "Resume operation requires a sessionId");
        }
        sessionId = op.sessionId;

        // Resume existing session
        session = await client.resumeSession(sessionId, {
          onPermissionRequest: permissionHandler,
          model: resolvedModel,
          reasoningEffort: opts.providerOptions?.copilot?.reasoningEffort,
          tools: convertToolsToSdk(opts.tools ?? tools, opts.abortSignal, emitToolProgress),
          onEvent: onSdkEvent,
        });

        // In-place rewind: truncate the session history to (and including)
        // op.atMessageId before sending the prompt. Uses the experimental
        // session-scoped `session.rpc.history.truncate({ eventId })` RPC
        // (@github/copilot-sdk/dist/generated/rpc.d.ts SessionHistoryTruncateParams):
        // "this event and all events after it are removed from the session."
        // Same session id is preserved.
        if (op.atMessageId) {
          await session.rpc.history.truncate({ eventId: op.atMessageId });
        }
      } else if (op.kind === "fork") {
        // Fork via the experimental sessions.fork RPC
        // (`@github/copilot-sdk/dist/generated/rpc.d.ts`: SessionsForkParams).
        // The high-level CopilotClient does not expose forkSession() yet, but
        // the public `client.rpc.sessions.fork(...)` getter on
        // CopilotClient wires the typed call. After the fork RPC returns the
        // new sessionId, we attach via resumeSession() to register handlers
        // and stream events.
        if (!op.sourceSessionId) {
          throw new AgentError("invalid_input", "Fork operation requires a sourceSessionId");
        }

        const forkResult = await client.rpc.sessions.fork({
          sessionId: op.sourceSessionId,
          ...(op.atMessageId ? { toEventId: op.atMessageId } : {}),
        });
        sessionId = forkResult.sessionId;
        if (!sessionId) {
          throw new AgentError("provider", "Copilot SDK sessions.fork returned no sessionId");
        }

        try {
          session = await client.resumeSession(sessionId, {
            onPermissionRequest: permissionHandler,
            model: resolvedModel,
            reasoningEffort: opts.providerOptions?.copilot?.reasoningEffort,
            tools: convertToolsToSdk(opts.tools ?? tools, opts.abortSignal, emitToolProgress),
            onEvent: onSdkEvent,
          });
        } catch (err) {
          // Best-effort: clean up the server-side forked session if we
          // can't attach to it. Don't mask the original error.
          await client.deleteSession(sessionId).catch(() => {});
          throw err;
        }

        // Defer emission until after we've yielded the standard session event
        // path (handled below) so consumers see session → session_forked in a
        // consistent order.
        pendingSessionForkedSourceId = op.sourceSessionId;
      } else {
        // Pre-generate the sessionId so the wrapper owns the invariant and the
        // caller can observe it immediately. The SDK's SessionConfig accepts
        // a caller-supplied `sessionId` (see
        // @github/copilot-sdk/dist/types.d.ts SessionConfig.sessionId) and
        // uses it verbatim. When the user passes options.sessionId, honor
        // that value instead of generating a fresh UUID.
        sessionId = op.pinnedSessionId ?? randomUUID();

        // Start new session
        session = await client.createSession({
          sessionId,
          onPermissionRequest: permissionHandler,
          model: resolvedModel,
          reasoningEffort: opts.providerOptions?.copilot?.reasoningEffort,
          tools: convertToolsToSdk(opts.tools ?? tools, opts.abortSignal, emitToolProgress),
          systemMessage: buildCopilotSystemMessage(opts.systemPrompt, opts.appendSystemPrompt),
          workingDirectory: cwd,
          onEvent: onSdkEvent,
        });

        if (!session.sessionId || session.sessionId !== sessionId) {
          throw new AgentError(
            "provider",
            "Copilot SDK returned a mismatched or missing session ID",
          );
        }
      }

      // Emit lifecycle event so callers can observe the (possibly forked /
      // pinned) session id. For fork ops, emit `session_forked` instead of
      // `session` to preserve the source-id linkage; the stream layer
      // resolves sessionId off either event. We deliberately skip `session`
      // emission on plain resume (matches opencode/acp conventions — the
      // caller already knows the id they passed in).
      if (pendingSessionForkedSourceId) {
        yield sessionForkedEvent(sessionId, pendingSessionForkedSourceId);
      } else if (op.kind === "start") {
        yield sessionEvent(sessionId);
      }

      // SDK event handler is already attached via `onEvent` above (so events
      // emitted between session.create/resume RPC start and completion are
      // not lost). No additional `session.on(...)` registration needed.
      const unsubscribe = (): void => {
        // No-op: onEvent handlers persist for the session's lifetime and are
        // cleaned up when the session is disposed.
      };

      // Wire abortSignal: SDK's session.send() does not accept an AbortSignal,
      // so we register a listener that calls session.abort() on cancellation.
      // TODO: pass abortSignal directly if/when SDK adds support on send().
      if (opts.abortSignal && session) {
        const sess = session;
        if (opts.abortSignal.aborted) {
          // Best-effort abort; ignore errors (session may not have a pending request yet).
          sess.abort().catch(() => {});
        } else {
          abortListener = () => {
            sess.abort().catch(() => {});
          };
          opts.abortSignal.addEventListener("abort", abortListener, { once: true });
        }
      }

      try {
        // Convert attachments if provided. SDK supports: file | directory | selection | blob.
        type SdkAttachment =
          | { type: "file"; path: string; displayName?: string }
          | { type: "directory"; path: string; displayName?: string }
          | { type: "blob"; data: string; mimeType: string; displayName?: string };

        const sdkAttachments: SdkAttachment[] = [];
        for (const att of opts.attachments ?? []) {
          if (att.type === "file") {
            sdkAttachments.push({ type: "file", path: att.path });
          } else if (att.type === "image") {
            const data = Buffer.from(att.data).toString("base64");
            sdkAttachments.push({ type: "blob", data, mimeType: att.mimeType });
          } else if (att.type === "image_url") {
            // SSRF guard: parse URL and block loopback / private-range hosts.
            let parsedUrl: URL;
            try {
              parsedUrl = new URL(att.url);
            } catch {
              throw new AgentError(
                "invalid_input",
                `image_url fetch blocked: invalid URL`,
                undefined,
                "invalid_url",
              );
            }
            if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
              throw new AgentError(
                "invalid_input",
                `image_url fetch blocked: unsupported protocol '${parsedUrl.protocol}'`,
                undefined,
                "ssrf_blocked",
              );
            }
            if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
              throw new AgentError(
                "invalid_input",
                "image_url fetch blocked: private/loopback address",
                undefined,
                "ssrf_blocked",
              );
            }
            // Merge caller's abortSignal with a default 30s timeout.
            const timeoutSignal = AbortSignal.timeout(IMAGE_URL_FETCH_TIMEOUT_MS);
            const fetchSignal = opts.abortSignal
              ? AbortSignal.any([opts.abortSignal, timeoutSignal])
              : timeoutSignal;
            const resp = await fetch(att.url, { signal: fetchSignal });
            if (!resp.ok) {
              throw new AgentError(
                "transport",
                `Failed to fetch image_url attachment: ${resp.status} ${resp.statusText}`,
                { url: att.url, status: resp.status },
              );
            }
            // Reject responses that declare a body larger than our limit before downloading.
            const contentLengthHeader = resp.headers.get("content-length");
            if (contentLengthHeader) {
              const declaredLen = Number(contentLengthHeader);
              if (Number.isFinite(declaredLen) && declaredLen > IMAGE_URL_MAX_BODY_BYTES) {
                throw new AgentError(
                  "invalid_input",
                  `image_url fetch blocked: body exceeds ${IMAGE_URL_MAX_BODY_BYTES} bytes`,
                  undefined,
                  "body_too_large",
                );
              }
            }
            const mimeType = resp.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.byteLength > IMAGE_URL_MAX_BODY_BYTES) {
              throw new AgentError(
                "invalid_input",
                `image_url fetch blocked: body exceeds ${IMAGE_URL_MAX_BODY_BYTES} bytes`,
                undefined,
                "body_too_large",
              );
            }
            sdkAttachments.push({
              type: "blob",
              data: buf.toString("base64"),
              mimeType,
            });
          } else if (att.type === "resource") {
            if (typeof att.content !== "string") {
              throw notSupported(
                `Copilot SDK resource attachment requires string content (got ${typeof att.content} for "${att.name}")`,
                "resource_unsupported",
              );
            }
            sdkAttachments.push({
              type: "blob",
              data: Buffer.from(att.content, "utf8").toString("base64"),
              mimeType: att.mimeType ?? "text/plain",
              displayName: att.name,
            });
          } else {
            throw notSupported(
              `Copilot SDK does not support attachment type: ${(att as { type: string }).type}`,
              "attachment_unsupported",
            );
          }
        }

        // Send the message (events will arrive via callback)
        await session.send({
          prompt: op.prompt,
          attachments: sdkAttachments.length > 0 ? sdkAttachments : undefined,
        });

        // Stream events as they arrive in the queue
        let lastAssistantMessage: string | undefined;
        let turnEnded = false;
        let idx = 0;

        while (true) {
          // Wait for events if queue is empty
          while (idx >= eventQueue.length) {
            await queuePromise();
          }

          const item = eventQueue[idx];
          if (!item) break; // Should never happen

          idx++;

          if (item.kind === "done") {
            break;
          }

          if (item.kind === "error") {
            throw item.error;
          }

          if (item.kind === "agent") {
            yield item.event;
            continue;
          }

          // item.kind === "sdk": raw SessionEvent to be normalized
          const sdkEvent = item.event;
          yield rawEvent("copilot", sdkEvent);

          const normalized = normalizeEvent(sdkEvent);
          for (const agentEvent of normalized) {
            if (agentEvent.type === "assistant_message") {
              lastAssistantMessage = agentEvent.text;
            }
            if (agentEvent.type === "turn_end") {
              turnEnded = true;
            }
            yield agentEvent;
          }
        }

        // Ensure we emit turn_end if not received
        if (!turnEnded) {
          yield turnEndEvent("end_turn");
        }

        // Emit final result
        yield resultEvent(sessionId, lastAssistantMessage ?? "", { sessionId });
      } finally {
        unsubscribe();
      }
    } catch (err) {
      yield errorEvent(err instanceof Error ? err.message : String(err), "provider", err);
      // Unblock any consumer still awaiting queuePromise(): push a done sentinel
      // and wake the resolver. This covers the case where session.send() (or an
      // earlier step) threw before any SDK event fired — without this, pending
      // awaiters on the queue would hang forever.
      eventQueue.push({ kind: "done" });
      notifyQueue();
    } finally {
      // Cleanup
      if (abortListener && opts.abortSignal) {
        opts.abortSignal.removeEventListener("abort", abortListener);
      }
      if (session) {
        try {
          session.disconnect();
        } catch {
          // Ignore disconnect errors
        }
      }
      if (client) {
        // Before tearing down the JSONRPC connection, wait for any in-flight
        // RPC responses to settle. The Copilot SDK's stop() synchronously
        // fires the JSONRPC disposeEmitter, which rejects all pending
        // response promises with code -32097 ("Pending response rejected
        // since connection got disposed"). Those rejections have no .catch()
        // attached and surface as unhandled rejections — which bun's test
        // runner counts as test failures regardless of process.on listeners.
        // Draining them first avoids the race entirely.
        try {
          const conn = (
            client as unknown as { connection?: { hasPendingResponse?: () => boolean } }
          ).connection;
          if (conn?.hasPendingResponse) {
            const deadline = Date.now() + 2000;
            while (conn.hasPendingResponse() && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 10));
            }
          }
        } catch {
          // Best-effort
        }
        try {
          await client.stop();
        } catch {
          // Ignore stop errors
        }
      }
      if (sandboxCleanup) {
        try {
          await sandboxCleanup();
        } catch {
          // Best-effort: profile-file cleanup is non-critical
        }
      }
    }
  }

  return {
    name: "copilot",
    transport: "sdk",

    stream(op: StreamOp, opts: CallOptions): AsyncIterable<AgentEvent> {
      return streamImpl(op, opts);
    },

    async deleteSession(sessionId: string): Promise<void> {
      // Delete requires a fresh client instance
      let client: CopilotClient | null = null;
      let sandboxCleanup: (() => Promise<void>) | undefined;
      try {
        const sandboxed = await buildSandboxedCopilotCliOpts(binPath, cwd, config?.sandbox);
        sandboxCleanup = sandboxed.cleanup;
        client = new CopilotClient({
          cliPath: sandboxed.cliPath,
          ...(sandboxed.cliArgs ? { cliArgs: sandboxed.cliArgs } : {}),
          cwd,
          logLevel: "error",
        });

        await client.start();
        await client.deleteSession(sessionId);
      } finally {
        if (client) {
          try {
            const conn = (
              client as unknown as { connection?: { hasPendingResponse?: () => boolean } }
            ).connection;
            if (conn?.hasPendingResponse) {
              const deadline = Date.now() + 2000;
              while (conn.hasPendingResponse() && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 10));
              }
            }
          } catch {
            // Best-effort
          }
          try {
            await client.stop();
          } catch {
            // Ignore stop errors
          }
        }
        if (sandboxCleanup) {
          try {
            await sandboxCleanup();
          } catch {
            // Best-effort
          }
        }
      }
    },

    async dispose() {
      // Nothing to dispose at the transport level
      // Each stream() call manages its own client lifecycle
    },
  };
}

function normalizeEvent(ev: SessionEvent): AgentEvent[] {
  const events: AgentEvent[] = [];
  const meta: Record<string, unknown> = {};

  if (ev.id) meta.copilotEventId = ev.id;
  if (ev.parentId) meta.copilotParentId = ev.parentId;
  if (ev.timestamp) meta.copilotTimestamp = ev.timestamp;
  if (ev.ephemeral) meta.ephemeral = true;

  const hasMeta = Object.keys(meta).length > 0;

  switch (ev.type) {
    // Session lifecycle
    case "session.start":
    case "session.resume": {
      // Session event already emitted at start
      const event: AgentEvent = {
        type: "extension",
        namespace: "copilot",
        kind: ev.type,
        data: ev.data,
      };
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    case "session.idle": {
      // Idle means turn completed
      break;
    }

    case "session.error": {
      const errorData = ev.data as { message?: string; stack?: string };
      const event = errorEvent(errorData.message ?? "Unknown error", "provider", errorData);
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    // Turn lifecycle
    case "assistant.turn_start": {
      const event = turnStartEvent();
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    case "assistant.turn_end": {
      const event = turnEndEvent("end_turn");
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    // Messages
    case "user.message": {
      const msgData = ev.data as { content?: string; transformedContent?: string };
      const text = msgData.content ?? msgData.transformedContent ?? "";
      const event: AgentEvent = { type: "user_message", text };
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    case "assistant.message_delta": {
      const deltaData = ev.data as { deltaContent?: string; messageId?: string };
      const delta = deltaData.deltaContent ?? "";
      const messageId = deltaData.messageId;
      const event = textDeltaEvent(delta, messageId);
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    case "assistant.message": {
      const msgData = ev.data as { content?: string; messageId?: string };
      const text = msgData.content ?? "";
      const messageId = msgData.messageId;

      // Since SDK doesn't always stream deltas, synthesize them from the final message
      // This allows textStream to work properly
      if (text) {
        const chunkSize = 50; // Reasonable chunk size for streaming simulation
        for (let i = 0; i < text.length; i += chunkSize) {
          const delta = text.slice(i, Math.min(i + chunkSize, text.length));
          const deltaEvent = textDeltaEvent(delta, messageId);
          events.push(hasMeta ? withMeta(deltaEvent, meta) : deltaEvent);
        }
      }

      const event: AgentEvent = { type: "assistant_message", text, messageId };
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    // Tool calls — emitted by the SDK as `tool.execution_start` / `tool.execution_complete`.
    case "tool.execution_start": {
      const toolData = ev.data as {
        toolCallId?: string;
        toolName?: string;
        arguments?: Record<string, unknown>;
      };
      const callId = toolData.toolCallId ?? ev.id ?? "unknown";
      const name = toolData.toolName ?? "unknown";
      const input = toolData.arguments ?? {};
      const event = toolCallEvent(callId, name, input, "in_progress");
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    case "tool.execution_complete": {
      const toolData = ev.data as {
        toolCallId?: string;
        success?: boolean;
        result?: { content?: string; detailedContent?: string; contents?: unknown };
        error?: { message?: string } | string;
      };
      const callId = toolData.toolCallId ?? ev.id ?? "unknown";
      const isError = toolData.success === false;
      const output: unknown =
        toolData.result?.contents ??
        toolData.result?.detailedContent ??
        toolData.result?.content ??
        (isError
          ? typeof toolData.error === "string"
            ? toolData.error
            : (toolData.error?.message ?? "Tool execution failed")
          : "");
      const event = toolResultEvent(callId, output, isError, isError ? "failed" : "completed");
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    // Usage/metrics
    case "assistant.usage": {
      const usageData = ev.data as {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
      };
      const event: AgentEvent = {
        type: "usage",
        inputTokens: usageData.inputTokens,
        outputTokens: usageData.outputTokens,
        totalTokens: usageData.totalTokens,
        cachedReadTokens: usageData.cachedReadTokens,
        cachedWriteTokens: usageData.cachedWriteTokens,
      };
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    // Extensions for other events
    case "session.mcp_server_status_changed":
    case "session.mcp_servers_loaded":
    case "session.skills_loaded":
    case "session.tools_updated": {
      const event: AgentEvent = {
        type: "extension",
        namespace: "copilot",
        kind: ev.type,
        data: ev.data ?? {},
      };
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }

    default: {
      // Unknown event → raw
      const event = rawEvent("copilot", ev);
      events.push(hasMeta ? withMeta(event, meta) : event);
      break;
    }
  }

  return events;
}
