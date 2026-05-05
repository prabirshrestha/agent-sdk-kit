// TODO: Resume across separate stream() calls would require a persistent ACP
// client at the Provider level (the spawned ACP child process and its session
// must outlive a single call). Today this transport spawns the child lazily
// on first stream() and disposes with the provider; sessions cannot be
// resumed across process restarts. The e2e test for cross-call resume is
// currently skipped as a result.
import type {
  ProviderImpl,
  StreamOp,
  CallOptions,
  AgentEvent,
  Attachment,
  ContentPart,
  SandboxConfig,
} from "../types.js";
import { AgentError, notSupported } from "../errors.js";
import {
  sessionEvent,
  turnStartEvent,
  textDeltaEvent,
  resultEvent,
  withMeta,
  permissionRequestEvent,
  availableCommandsEvent,
  usageEvent,
} from "../events.js";
import {
  materializeAttachments,
  cleanupAttachments,
  type MaterializedAttachment,
} from "../attachments.js";
import { spawnProcessWithStdin, type SpawnedProcessWithStdin } from "../runtime.js";
import { applySandbox } from "../sandbox/index.js";
import * as acp from "@zed-industries/agent-client-protocol";

// Local alias for the ACP ContentBlock union (exported by the schema).
type AcpContentBlock = acp.ContentBlock;

/**
 * Build the ACP prompt blocks for a single turn.
 *
 * Mapping (see ACP ContentBlock schema):
 *  - the text prompt becomes a leading `{type:"text", text}` block.
 *  - attachments `{type:"file", path}` → `{type:"resource_link", uri:"file://…", name, mimeType}`
 *  - attachments `{type:"image", data, mimeType}` → `{type:"image", data:base64, mimeType}`
 *    (materialized to a temp file first so we can reuse the shared materializer,
 *     then read back and base64-encoded).
 *  - attachments `{type:"image_url", url}` → fetched via materializeAttachments,
 *    emitted as `{type:"image", data:base64, mimeType}`.
 *  - attachments `{type:"resource", name, content, mimeType}` →
 *    `{type:"resource", resource:{uri:"agent-sdk://<name>", mimeType, text}}`.
 *  - opts.parts (ContentPart union) is passed through if the shape already
 *    matches a valid ACP ContentBlock; unknown/unsupported shapes are skipped
 *    with a console.warn.
 *
 * Returns the ContentBlock array plus a cleanup() that unlinks any temp files.
 */
async function buildAcpPromptBlocks(
  prompt: string,
  attachments: Attachment[] | undefined,
  parts: ContentPart[] | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<{ blocks: AcpContentBlock[]; cleanup: () => Promise<void> }> {
  const out: AcpContentBlock[] = [{ type: "text", text: prompt }];
  const materialized: MaterializedAttachment[] = attachments?.length
    ? await materializeAttachments(attachments, abortSignal)
    : [];

  for (const mat of materialized) {
    try {
      if (mat.origType === "file") {
        // Keep files as resource_link so the agent fetches them lazily.
        const name = mat.path.split(/[\\/]/).pop() ?? mat.path;
        const block: AcpContentBlock = {
          type: "resource_link",
          uri: `file://${mat.path}`,
          name,
          ...(mat.mimeType ? { mimeType: mat.mimeType } : {}),
        };
        out.push(block);
      } else if (mat.origType === "image" || mat.origType === "image_url") {
        // Materialized to a temp file; read + base64 for inline ACP image block.
        const fs = await import("node:fs/promises");
        const bytes = await fs.readFile(mat.path);
        const data = bytes.toString("base64");
        const mimeType = mat.mimeType ?? "image/png";
        out.push({ type: "image", data, mimeType });
      } else if (mat.origType === "resource") {
        // Inline the text content as an embedded resource. Use agent-sdk://<name>
        // since the user-supplied resource is synthetic and has no real URI.
        const fs = await import("node:fs/promises");
        const text = await fs.readFile(mat.path, "utf-8");
        const name = mat.path.split(/[\\/]/).pop() ?? "resource";
        const block: AcpContentBlock = {
          type: "resource",
          resource: {
            uri: `agent-sdk://${name}`,
            text,
            ...(mat.mimeType ? { mimeType: mat.mimeType } : {}),
          },
        };
        out.push(block);
      }
    } catch (err) {
      console.warn("agent-sdk: failed to convert attachment to ACP content block", err);
    }
  }

  // ContentPart → ContentBlock pass-through. ContentPart is modeled after ACP,
  // so shapes usually line up 1:1; we still validate the discriminant defensively.
  if (parts) {
    for (const p of parts) {
      try {
        const maybe = contentPartToAcpBlock(p);
        if (maybe) out.push(maybe);
      } catch (err) {
        console.warn("agent-sdk: failed to convert ContentPart to ACP block", p, err);
      }
    }
  }

  return {
    blocks: out,
    cleanup: () => cleanupAttachments(materialized),
  };
}

/** Convert a ContentPart into an ACP ContentBlock, or null to skip. */
function contentPartToAcpBlock(p: ContentPart): AcpContentBlock | null {
  switch (p.type) {
    case "text": {
      const { text } = p as { type: "text"; text: string };
      return { type: "text", text };
    }
    case "image": {
      const { data, mimeType } = p as { type: "image"; data: string; mimeType: string };
      return { type: "image", data, mimeType };
    }
    case "audio": {
      const { data, mimeType } = p as { type: "audio"; data: string; mimeType: string };
      return { type: "audio", data, mimeType };
    }
    case "resource_link": {
      const { uri, name, mimeType } = p as {
        type: "resource_link";
        uri: string;
        name?: string;
        mimeType?: string;
      };
      return {
        type: "resource_link",
        uri,
        name: name ?? uri,
        ...(mimeType ? { mimeType } : {}),
      };
    }
    case "resource": {
      const { resource } = p as {
        type: "resource";
        resource: { uri: string; mimeType?: string; text?: string };
      };
      // ACP EmbeddedResourceResource requires either TextResourceContents or
      // BlobResourceContents. We only have `text` in the ContentPart shape.
      if (resource.text != null) {
        return {
          type: "resource",
          resource: {
            uri: resource.uri,
            text: resource.text,
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          },
        };
      }
      console.warn(
        `agent-sdk: ACP transport requires resource.text for embedded resources; skipping ${resource.uri}`,
      );
      return null;
    }
    default:
      console.warn(`agent-sdk: ACP transport skipping ContentPart of unsupported type: ${p.type}`);
      return null;
  }
}

/**
 * Create an ACP transport provider.
 * Spawns an ACP-compatible server subprocess and communicates over stdio.
 */
export function createAcpTransport(
  spawn: string[],
  cwd?: string,
  env?: Record<string, string>,
  sandbox?: SandboxConfig,
  defaultModel?: string,
): ProviderImpl {
  let childProcess: SpawnedProcessWithStdin | null = null;
  let agentClient: any = null;
  let acpAutoApproveWarned = false;
  let acpToolsWarned = false;
  let acpSystemPromptWarned = false;
  let sandboxCleanup: (() => Promise<void>) | undefined;

  // Per-session dispatch table. Each stream() registers its handlers keyed by
  // the ACP sessionId so concurrent stream() calls don't cross-contaminate
  // (the previous single mutable `clientCallbacks` was overwritten per call).
  type SessionHandlers = {
    sessionUpdate: (params: any) => Promise<void> | void;
    requestPermission: (params: any) => Promise<any>;
  };
  const sessionHandlers = new Map<string, SessionHandlers>();

  // Per-session "does the agent advertise model selection?" — populated from
  // NewSessionResponse.models. Used to decide whether to attempt the
  // experimental session/set_model RPC (schema marks it UNSTABLE).
  const sessionSupportsModelSelection = new Map<string, boolean>();

  // Serialize concurrent initialization. Without this, two concurrent stream()
  // calls both observe `!agentClient`, both spawn a child process, and both
  // call initialize(). Mirrors the pattern in sdk-opencode.ts.
  let initPromise: Promise<void> | null = null;
  async function ensureConnected(): Promise<void> {
    if (agentClient) return;
    if (!initPromise) {
      initPromise = (async () => {
        const [command, ...args] = spawn;

        if (!command) {
          throw new AgentError("invalid_input", "ACP spawn command is empty");
        }

        // Filter undefined env values so the env record typechecks as
        // Record<string, string> under our runtime shim.
        const envRecord: Record<string, string> = {};
        for (const [k, v] of Object.entries({ ...process.env, ...env })) {
          if (typeof v === "string") envRecord[k] = v;
        }

        // Wrap with `nono run …` if a sandbox config was provided. SDK
        // transports (copilot/opencode) cannot use this since they run
        // in-process; ACP spawns a real child, so the sandbox is enforceable.
        let cmd = [command, ...args];
        if (sandbox) {
          const sandboxResult = await applySandbox(cmd, cwd || process.cwd(), sandbox);
          cmd = sandboxResult.cmd;
          sandboxCleanup = sandboxResult.cleanup;
        }
        const [exec, ...execArgs] = cmd;
        if (!exec) {
          throw new AgentError("invalid_input", "ACP spawn command is empty after sandbox wrap");
        }

        childProcess = spawnProcessWithStdin([exec, ...execArgs], {
          cwd: cwd || process.cwd(),
          env: envRecord,
          stderr: "inherit",
        });

        const input = childProcess.stdout;
        const output = childProcess.stdin;

        const stream = acp.ndJsonStream(output, input);

        let tempAgentRef: any;
        const _connection = new acp.ClientSideConnection((agent: any) => {
          tempAgentRef = agent;
          return {
            sessionUpdate: async (params: any) => {
              const sid = params?.sessionId;
              const h = sid ? sessionHandlers.get(sid) : undefined;
              if (h) await h.sessionUpdate(params);
            },
            requestPermission: async (params: any) => {
              const sid = params?.sessionId;
              const h = sid ? sessionHandlers.get(sid) : undefined;
              if (h) return await h.requestPermission(params);
              // No per-session handler registered → auto-allow.
              return {
                outcome: "selected" as const,
                optionId: "allow",
              };
            },
          };
        }, stream);

        agentClient = tempAgentRef;
        try {
          await agentClient.initialize({
            clientCapabilities: {
              tools: true,
              permissions: true,
              notifications: true,
            },
            protocolVersion: acp.PROTOCOL_VERSION,
          });
        } catch (err) {
          throw new AgentError(
            "provider",
            `Failed to initialize ACP connection: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        }
      })().catch((err) => {
        // Reset so the next caller can retry cleanly.
        initPromise = null;
        agentClient = null;
        if (childProcess) {
          try {
            childProcess.kill();
          } catch {
            // best-effort
          }
          childProcess = null;
        }
        throw err;
      });
    }
    return initPromise;
  }

  return {
    name: "acp",
    transport: "acp",

    async *stream(op: StreamOp, opts: CallOptions): AsyncIterable<AgentEvent> {
      // Initialize connection on first call (serialized to prevent race).
      await ensureConnected();

      let accumulatedText = "";
      let sessionId: string | undefined = op.kind === "resume" ? op.sessionId : undefined;
      const eventQueue: AgentEvent[] = [];

      // Helper: push an event, augmenting with _meta from the ACP update if present
      const pushEvent = (event: AgentEvent, meta: unknown) => {
        if (meta && typeof meta === "object") {
          eventQueue.push(withMeta(event, meta as Record<string, unknown>));
        } else {
          eventQueue.push(event);
        }
      };

      // Helper: extract subagent linkage from an ACP toolCall object
      const extractSubagent = (
        toolCall: any,
      ): { subagentId: string; childSessionId?: string; agentName?: string } | undefined => {
        const sub = toolCall?.subagent;
        if (sub && typeof sub === "object") {
          const subagentId = sub.subagentId ?? sub.id;
          if (subagentId) {
            return {
              subagentId: String(subagentId),
              childSessionId: sub.childSessionId ?? sub.sessionId,
              agentName: sub.agentName ?? sub.name,
            };
          }
        }
        const subagentId = toolCall?.subagentId;
        if (subagentId) {
          return {
            subagentId: String(subagentId),
            childSessionId: toolCall?.childSessionId,
            agentName: toolCall?.agentName,
          };
        }
        return undefined;
      };

      // Per-stream handlers; registered in sessionHandlers once sessionId is
      // known (after newSession / resume). The ACP client dispatches inbound
      // notifications by looking up handlers keyed on sessionId, so concurrent
      // stream() calls each get their own events without cross-talk.
      const handleSessionUpdate = (notification: any) => {
        try {
          const update = notification.update;
          if (!update) return;
          const meta = update._meta;

          if (update.sessionUpdate === "agent_message_chunk") {
            const content = update.content;
            if (content?.type === "text" && content.text) {
              accumulatedText += content.text;
              pushEvent(textDeltaEvent(content.text), meta);
            }
          } else if (update.sessionUpdate === "agent_thought_chunk") {
            const content = update.content;
            if (content?.type === "text" && content.text) {
              pushEvent(
                {
                  type: "thinking_delta",
                  delta: content.text,
                },
                meta,
              );
            }
          } else if (update.sessionUpdate === "tool_call") {
            const toolCall = update.toolCall;
            if (toolCall) {
              const subagent = extractSubagent(toolCall);
              pushEvent(
                {
                  type: "tool_call",
                  callId: toolCall.id || `call_${Date.now()}`,
                  name: toolCall.name || "unknown",
                  input: toolCall.input || {},
                  status: "pending",
                  ...(toolCall.kind ? { toolKind: toolCall.kind } : {}),
                  ...(subagent ? { subagent } : {}),
                },
                meta,
              );
            }
          } else if (update.sessionUpdate === "tool_call_update") {
            const toolCall = update.toolCall;
            if (toolCall) {
              const status = toolCall.status?.toLowerCase();

              if (status === "completed" || status === "failed" || status === "cancelled") {
                pushEvent(
                  {
                    type: "tool_result",
                    callId: toolCall.id || `call_${Date.now()}`,
                    output: toolCall.output || toolCall.error || {},
                    isError: status === "failed",
                    status: status as "completed" | "failed" | "cancelled",
                  },
                  meta,
                );
              } else {
                const subagent = extractSubagent(toolCall);
                pushEvent(
                  {
                    type: "tool_call",
                    callId: toolCall.id || `call_${Date.now()}`,
                    name: toolCall.name || "unknown",
                    input: toolCall.input || {},
                    status: status === "in_progress" ? "in_progress" : "pending",
                    ...(toolCall.kind ? { toolKind: toolCall.kind } : {}),
                    ...(subagent ? { subagent } : {}),
                  },
                  meta,
                );
              }
            }
          } else if (update.sessionUpdate === "plan") {
            const plan = update.plan;
            if (plan && Array.isArray(plan.entries)) {
              pushEvent(
                {
                  type: "todo_update",
                  items: plan.entries.map((entry: any) => ({
                    id: entry.id || `todo_${Date.now()}`,
                    text: entry.description || entry.title || "",
                    status:
                      entry.status === "complete"
                        ? "done"
                        : entry.status === "in_progress"
                          ? "in_progress"
                          : "pending",
                  })),
                },
                meta,
              );
            }
          } else if (update.sessionUpdate === "current_mode_update") {
            pushEvent(
              {
                type: "extension",
                namespace: "acp",
                kind: "mode_update",
                data: update.mode || {},
              },
              meta,
            );
          } else if (update.sessionUpdate === "available_commands_update") {
            const rawCommands = update.availableCommands ?? update.commands ?? [];
            const commands = Array.isArray(rawCommands)
              ? rawCommands.map((c: any) => ({
                  name: String(c?.name ?? ""),
                  description: c?.description,
                }))
              : [];
            pushEvent(availableCommandsEvent(commands), meta);
          } else if (update.sessionUpdate === "usage_update") {
            const u = update.usage ?? update;
            pushEvent(
              usageEvent({
                inputTokens: u?.inputTokens,
                outputTokens: u?.outputTokens,
                cachedReadTokens: u?.cachedReadTokens ?? u?.cacheReadTokens,
                cachedWriteTokens: u?.cachedWriteTokens ?? u?.cacheWriteTokens,
                thoughtTokens: u?.thoughtTokens,
                totalTokens: u?.totalTokens,
                contextUsed: u?.contextUsed,
                contextSize: u?.contextSize,
                costUsd: u?.costUsd,
              }),
              meta,
            );
          }
        } catch {
          // Silently ignore errors in session update processing
        }
      };

      const handleRequestPermission = async (params: any) => {
        const toolCall = params?.toolCall ?? {};
        const req = {
          requestId: String(params?.requestId ?? toolCall.id ?? `req_${Date.now()}`),
          toolName: String(toolCall.name ?? params?.toolName ?? "unknown"),
          details: toolCall.input ?? params,
        };

        // Manual Promise so either the out-of-band event.respond() path or the
        // user's onPermissionRequest callback can resolve the decision. We
        // carry `persist` so we can prefer an "allow_always" option when the
        // ACP server offers one (see PermissionOption.kind in the schema).
        type Resolved = { decision: "allow" | "deny"; persist?: boolean };
        let resolve!: (d: Resolved) => void;
        const decisionPromise = new Promise<Resolved>((r) => {
          resolve = r;
        });
        const respond = async (decision: "allow" | "deny", respOpts?: { persist?: boolean }) => {
          resolve({ decision, persist: respOpts?.persist });
        };

        // Surface the permission request on the event stream with a respond
        // callback so consumers iterating events can decide out-of-band.
        eventQueue.push(
          permissionRequestEvent(req.requestId, req.toolName, req.details, { respond }),
        );

        const userCallback = opts.onPermissionRequest;
        if (userCallback) {
          // Fire user callback in parallel; whichever path resolves first wins.
          void Promise.resolve()
            .then(() => userCallback(req))
            .then((decision) => {
              if (decision?.decision === "allow") {
                resolve({ decision: "allow", persist: decision.persist });
              } else {
                resolve({ decision: "deny" });
              }
            })
            .catch(() => {
              resolve({ decision: "deny" });
            });
        } else if (!acpAutoApproveWarned) {
          acpAutoApproveWarned = true;
          console.warn("agent-sdk: ACP auto-approving tool — provide onPermissionRequest to gate.");
        }

        // If no user callback, default to auto-approve after a microtask to
        // give any synchronous event.respond() a chance to fire first.
        if (!userCallback) {
          queueMicrotask(() => resolve({ decision: "allow" }));
        }

        const resolved = await decisionPromise;

        // Map (decision, persist) onto one of the server-offered options.
        // ACP servers present PermissionOption[] with a `kind` field of
        // "allow_once" | "allow_always" | "reject_once" | "reject_always"
        // (see @zed-industries/agent-client-protocol schema.ts:
        //   PermissionOption). If a matching option exists, return its
        // optionId. Otherwise fall back to returning the raw decision string
        // so we preserve the prior behavior for servers that don't follow
        // the convention.
        const offered: Array<{
          optionId?: unknown;
          kind?: unknown;
          name?: unknown;
        }> = Array.isArray(params?.options) ? params.options : [];

        const pickOption = (preferredKind: string, fallbackKinds: string[]): string | null => {
          // Exact `kind` match first.
          const byKind = offered.find((o) => o?.kind === preferredKind);
          if (byKind && typeof byKind.optionId === "string") return byKind.optionId;
          for (const fk of fallbackKinds) {
            const hit = offered.find((o) => o?.kind === fk);
            if (hit && typeof hit.optionId === "string") return hit.optionId;
          }
          // Fuzzy match on optionId/name for servers that don't set `kind`.
          const needle = preferredKind.includes("always")
            ? /always|forever|persist|remember/i
            : preferredKind.startsWith("allow")
              ? /^allow|approve|accept/i
              : /^(reject|deny|decline)/i;
          const byFuzzy = offered.find((o) => {
            const oid = typeof o?.optionId === "string" ? o.optionId : "";
            const nm = typeof o?.name === "string" ? o.name : "";
            return needle.test(oid) || needle.test(nm);
          });
          if (byFuzzy && typeof byFuzzy.optionId === "string") return byFuzzy.optionId;
          return null;
        };

        let optionId: string;
        if (resolved.decision === "allow") {
          const preferred = resolved.persist ? "allow_always" : "allow_once";
          const fallback = resolved.persist ? ["allow_once"] : ["allow_always"];
          const picked = pickOption(preferred, fallback);
          if (resolved.persist && (!picked || picked === pickOption("allow_once", []))) {
            // No distinct "always" option surfaced; persist is best-effort.
            console.debug(
              "agent-sdk: ACP persist=true but no allow_always option offered; falling back to one-shot allow.",
            );
          }
          optionId = picked ?? "allow";
        } else {
          const picked = pickOption("reject_once", ["reject_always"]);
          optionId = picked ?? "deny";
        }
        return { outcome: "selected" as const, optionId };
      };

      // TODO: ACP's NewSessionRequest / LoadSessionRequest schemas do not
      // currently accept client-side tool registration (see
      // @zed-industries/agent-client-protocol schema for NewSessionRequest —
      // it only takes { cwd, mcpServers }). The agent exposes its own tools
      // plus any tools surfaced via the configured MCP servers. If a future
      // ACP schema revision adds `clientTools` / `tools` to newSession, wire
      // `opts.tools` through here.
      if (opts.tools && Object.keys(opts.tools).length > 0 && !acpToolsWarned) {
        acpToolsWarned = true;
        console.warn(
          "agent-sdk: ACP transport ignores opts.tools — the ACP newSession/loadSession schema does not support client-side tool registration. Expose tools via an MCP server instead.",
        );
      }

      // ACP's NewSessionRequest / LoadSessionRequest schemas do not accept
      // systemPrompt (see @zed-industries/agent-client-protocol schema —
      // NewSessionRequest only takes { cwd, mcpServers }; the prompt RPC takes
      // ContentBlocks only). Callers must bake any system-prompt context into
      // the first user prompt themselves on this transport.
      if ((opts.systemPrompt || opts.appendSystemPrompt) && !acpSystemPromptWarned) {
        acpSystemPromptWarned = true;
        console.warn(
          "agent-sdk: ACP transport ignores opts.systemPrompt / appendSystemPrompt — the ACP newSession/loadSession/prompt schemas have no system-prompt field. Prepend the system context to your user prompt instead.",
        );
      }

      // Map McpServerConfig -> ACP schema. ACP currently only supports stdio
      // transports in its newSession/loadSession params; warn and skip the rest.
      const mappedMcpServers = (opts.mcpServers ?? [])
        .map((s) => {
          if (s.transport.type === "stdio") {
            return {
              name: s.name,
              command: s.transport.command,
              args: s.transport.args ?? [],
              env: s.transport.env
                ? Object.entries(s.transport.env).map(([name, value]) => ({ name, value }))
                : [],
            };
          }
          console.warn(
            `agent-sdk: ACP transport does not support MCP server "${s.name}" (transport=${s.transport.type}); skipping.`,
          );
          return null;
        })
        .filter((s): s is NonNullable<typeof s> => s !== null);

      // Abort wiring: on abort, attempt a graceful cancel RPC (awaited with a
      // short timeout), mark the event loop as terminated, and kill the child
      // process to unblock any outstanding RPC awaits.
      let aborted = false;
      const abortListener = () => {
        aborted = true;
        void (async () => {
          try {
            const cancelPromise = Promise.resolve(agentClient?.cancel?.({ sessionId }));
            await Promise.race([cancelPromise, new Promise((r) => setTimeout(r, 200))]);
          } catch {
            // best-effort
          }
          if (childProcess) {
            try {
              childProcess.kill();
            } catch {
              // best-effort
            }
          }
        })();
      };
      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          abortListener();
        } else {
          opts.abortSignal.addEventListener("abort", abortListener, { once: true });
        }
      }

      // Build ACP prompt blocks from text prompt + attachments + parts.
      // Materialization is done up-front so we can cleanup on any exit path.
      const { blocks: promptBlocks, cleanup: cleanupBlocks } = await buildAcpPromptBlocks(
        op.prompt,
        opts.attachments,
        opts.parts,
        opts.abortSignal,
      );

      // Track sessionId we registered handlers under so the finally block
      // can unregister the right entry even if sessionId is later reassigned.
      let registeredSessionId: string | undefined;

      try {
        // Handle different operation kinds
        if (op.kind === "start") {
          if (op.pinnedSessionId) {
            throw notSupported(
              "ACP transport does not support options.sessionId (pinning a UUID for a new session). The ACP server assigns the session id.",
              "pinned_session_id_unsupported",
            );
          }
          const newSessionResult = await agentClient.newSession({
            cwd: cwd || process.cwd(),
            mcpServers: mappedMcpServers,
          });

          sessionId = newSessionResult.sessionId;

          if (!sessionId) {
            throw new AgentError("provider", "ACP server did not return a session ID");
          }

          // Track whether the agent advertised model selection on this
          // session. ACP's session/set_model RPC is UNSTABLE per the schema
          // and only meaningful when NewSessionResponse.models is non-null.
          sessionSupportsModelSelection.set(sessionId, !!newSessionResult.models);

          // Register per-session handlers now that we know the sessionId.
          sessionHandlers.set(sessionId, {
            sessionUpdate: handleSessionUpdate,
            requestPermission: handleRequestPermission,
          });
          registeredSessionId = sessionId;

          yield sessionEvent(sessionId);
          yield turnStartEvent();
        } else if (op.kind === "resume") {
          if (!op.sessionId) {
            throw new AgentError("invalid_input", "Session ID required for resume");
          }
          if (op.atMessageId) {
            throw notSupported(
              "ACP transport does not support options.resumeSessionAt (resuming at a specific message UUID).",
              "resume_at_unsupported",
            );
          }

          sessionId = op.sessionId;

          // Register handlers for resumed sessionId before loadSession so
          // any notifications emitted during load are routed correctly.
          sessionHandlers.set(sessionId, {
            sessionUpdate: handleSessionUpdate,
            requestPermission: handleRequestPermission,
          });
          registeredSessionId = sessionId;

          // Try to load the session if supported
          if (agentClient.loadSession) {
            try {
              await agentClient.loadSession({
                sessionId,
                mcpServers: mappedMcpServers,
              });
              yield sessionEvent(sessionId);
              yield turnStartEvent();
            } catch (err) {
              throw new AgentError(
                "not_found",
                `Session ${sessionId} not found or could not be loaded`,
                err,
              );
            }
          } else {
            yield sessionEvent(sessionId);
            yield turnStartEvent();
          }
        } else if (op.kind === "fork") {
          throw notSupported(
            "ACP transport does not support fork; each call spawns a fresh ACP process and sessions are tied to that connection. Use options.resume within the same process lifecycle.",
            "fork_unsupported",
          );
        }

        // Per-call `opts.model` wins over construction-time `config.model`.
        // ACP's session/set_model RPC is UNSTABLE per the schema; only
        // attempt it when the agent advertised support via the session's
        // `models` capability. For resumed sessions whose support flag we
        // didn't capture (loadSession doesn't return `models`), best-effort:
        // try the call and surface a clear error if the agent rejects it.
        const modelOverride = opts.model ?? defaultModel;
        if (modelOverride && sessionId) {
          if (sessionSupportsModelSelection.get(sessionId) === false) {
            throw notSupported(
              `ACP agent did not advertise model selection on this session (NewSessionResponse.models was null), so model override "${modelOverride}" cannot be applied. The session/set_model capability is marked UNSTABLE in the ACP schema.`,
              "model_override_unsupported",
            );
          }
          if (!agentClient.setSessionModel) {
            throw notSupported(
              `ACP client does not implement setSessionModel; cannot apply model override "${modelOverride}".`,
              "model_override_unsupported",
            );
          }
          try {
            await agentClient.setSessionModel({ sessionId, modelId: modelOverride });
          } catch (err) {
            throw new AgentError(
              "provider",
              `ACP setSessionModel failed for "${modelOverride}": ${err instanceof Error ? err.message : String(err)}`,
              err,
            );
          }
        }

        // Send prompt (text + attachments + pass-through parts).
        const promptResult = await agentClient.prompt({
          sessionId,
          prompt: promptBlocks,
        });

        // Emit all queued events, stopping early if aborted
        for (const event of eventQueue) {
          if (aborted) break;
          yield event;
        }

        if (aborted) {
          yield { type: "turn_end" as const, stopReason: "cancelled" };
          return;
        }

        // Emit turn end and result
        const stopReason = promptResult.stopReason || "end_turn";
        yield { type: "turn_end" as const, stopReason };

        if (!sessionId) {
          throw new AgentError("provider", "Session ID is not set");
        }

        yield resultEvent(sessionId, accumulatedText, promptResult);
      } catch (err) {
        if (err instanceof AgentError) {
          throw err;
        }

        const message = err instanceof Error ? err.message : String(err);
        throw new AgentError("provider", `ACP error: ${message}`, err);
      } finally {
        if (opts.abortSignal) {
          opts.abortSignal.removeEventListener("abort", abortListener);
        }
        // Remove this stream's per-session handlers so future incoming
        // notifications for this sessionId (if any arrive late) fall through
        // to the auto-allow default rather than hitting a stale closure.
        if (registeredSessionId) {
          sessionHandlers.delete(registeredSessionId);
        }
        // Unlink any materialized temp files from attachments.
        await cleanupBlocks();
      }
    },

    async dispose() {
      sessionHandlers.clear();
      initPromise = null;
      if (childProcess) {
        childProcess.kill();
        childProcess = null;
      }
      agentClient = null;
      if (sandboxCleanup) {
        try {
          await sandboxCleanup();
        } catch {
          // ignore cleanup errors
        }
        sandboxCleanup = undefined;
      }
    },
  };
}
