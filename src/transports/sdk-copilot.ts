import { randomUUID } from "node:crypto";
import type {
  CopilotConfig,
  ProviderImpl,
  StreamOp,
  CallOptions,
  AgentEvent,
  AgentTool,
} from "../types.js";
import { AgentError, notSupported } from "../errors.js";
import {
  isPrivateOrLoopbackHost,
  IMAGE_URL_FETCH_TIMEOUT_MS,
  IMAGE_URL_MAX_BODY_BYTES,
} from "../attachments.js";
import {
  sessionEvent,
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
} from "@github/copilot-sdk";

interface CreateTransportOptions extends CopilotConfig {
  tools?: Record<string, AgentTool>;
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
    // StreamOp narrowing: handle fork early before allocating any resources.
    // The high-level @github/copilot-sdk CopilotClient does not expose a fork
    // method, even though the underlying RPC has `sessions.fork` (see
    // tmp/copilot-sdk/nodejs/src/generated/rpc.ts:2373). Implementing fork
    // would require reaching into private connection internals, which is not
    // a straightforward (<30 lines) integration. Surface NotSupported instead.
    // TODO: implement via SDK once `client.forkSession()` is exposed publicly.
    if (op.kind === "fork") {
      throw notSupported(
        "Copilot SDK does not support session fork (no client.forkSession exposed yet). Use options.resume to continue an existing session.",
        "fork_unsupported",
      );
    }
    if (op.kind === "continue") {
      throw notSupported(
        "Copilot SDK does not support options.continue (most recent session). Pass options.resume with an explicit session id.",
        "continue_unsupported",
      );
    }
    if (op.kind === "start" && op.pinnedSessionId) {
      throw notSupported(
        "Copilot SDK does not support options.sessionId (pinning a UUID for a new session).",
        "pinned_session_id_unsupported",
      );
    }
    if (op.kind === "resume" && op.atMessageId) {
      throw notSupported(
        "Copilot SDK does not support options.resumeSessionAt (resuming at a specific message UUID).",
        "resume_at_unsupported",
      );
    }

    let client: CopilotClient | null = null;
    let session: CopilotSession | null = null;
    let abortListener: (() => void) | undefined;

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
      // Create and start client
      client = new CopilotClient({
        cliPath: binPath,
        cwd,
        logLevel: "error",
        // Forward githubToken to the SDK when provided. The SDK accepts it as
        // a top-level option on CopilotClientOptions (see
        // tmp/copilot-sdk/nodejs/src/types.ts: `githubToken?: string`).
        ...(config?.githubToken ? { githubToken: config.githubToken } : {}),
      });

      await client.start();

      let sessionId: string;

      if (op.kind === "resume") {
        if (!op.sessionId) {
          throw new AgentError("invalid_input", "Resume operation requires a sessionId");
        }
        sessionId = op.sessionId;

        // Resume existing session
        session = await client.resumeSession(sessionId, {
          onPermissionRequest: permissionHandler,
          model: config?.model,
          reasoningEffort: opts.providerOptions?.copilot?.reasoningEffort,
          tools: convertToolsToSdk(opts.tools ?? tools, opts.abortSignal, emitToolProgress),
        });
      } else {
        // Pre-generate the sessionId so the wrapper owns the invariant and the
        // caller can observe it immediately. The SDK's
        // SessionConfig accepts a caller-supplied `sessionId` (see
        // tmp/copilot-sdk/nodejs/src/types.ts:1149) and uses it verbatim.
        sessionId = randomUUID();

        // Start new session
        session = await client.createSession({
          sessionId,
          onPermissionRequest: permissionHandler,
          model: config?.model,
          reasoningEffort: opts.providerOptions?.copilot?.reasoningEffort,
          tools: convertToolsToSdk(opts.tools ?? tools, opts.abortSignal, emitToolProgress),
          systemMessage: opts.systemPrompt
            ? {
                mode: "append" as const,
                content: opts.systemPrompt,
              }
            : undefined,
          workingDirectory: cwd,
        });

        if (!session.sessionId || session.sessionId !== sessionId) {
          throw new AgentError(
            "provider",
            "Copilot SDK returned a mismatched or missing session ID",
          );
        }

        // Emit session event immediately so caller knows the ID
        yield sessionEvent(sessionId);
      }

      // Register event handler that pushes to queue BEFORE sending
      const unsubscribe = session.on((event: SessionEvent) => {
        eventQueue.push({ kind: "sdk", event });
        notifyQueue();

        if (event.type === "session.idle") {
          eventQueue.push({ kind: "done" });
          notifyQueue();
        }
      });

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
        // Suppress vscode-jsonrpc's "Pending response rejected since connection
        // got disposed" rejections. The Copilot SDK's stop() synchronously
        // fires the JSONRPC disposeEmitter, which rejects any in-flight RPC
        // response promise — and we have no handle to attach a `.catch()` on
        // those internal promises. They're benign on shutdown.
        const swallow = (reason: unknown) => {
          const err = reason as { code?: number; message?: string } | undefined;
          if (
            err?.code === -32097 ||
            (typeof err?.message === "string" &&
              err.message.includes("Pending response rejected"))
          ) {
            return;
          }
          throw reason;
        };
        process.on("unhandledRejection", swallow);
        try {
          await client.stop();
        } catch {
          // Ignore stop errors
        } finally {
          // Give microtasks a tick to settle any rejections fired by stop()
          // before removing the swallower.
          await new Promise((r) => setImmediate(r));
          process.off("unhandledRejection", swallow);
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
      try {
        client = new CopilotClient({
          cliPath: binPath,
          cwd,
          logLevel: "error",
        });

        await client.start();
        await client.deleteSession(sessionId);
      } finally {
        if (client) {
          const swallow = (reason: unknown) => {
            const err = reason as { code?: number; message?: string } | undefined;
            if (
              err?.code === -32097 ||
              (typeof err?.message === "string" &&
                err.message.includes("Pending response rejected"))
            ) {
              return;
            }
            throw reason;
          };
          process.on("unhandledRejection", swallow);
          try {
            await client.stop();
          } catch {
            // Ignore stop errors
          } finally {
            await new Promise((r) => setImmediate(r));
            process.off("unhandledRejection", swallow);
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
