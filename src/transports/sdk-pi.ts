/**
 * Pi provider — SDK transport (in-process, programmatic).
 *
 * Uses `@mariozechner/pi-coding-agent`'s `createAgentSession` rather than
 * spawning the `pi` binary. Verified against `@mariozechner/pi-coding-agent@^0.73.1`.
 *
 * Comparison vs the CLI transport (src/providers/pi.ts:_streamPi):
 * - In-process: no PATH dependency, no JSONL parsing, no subprocess lifecycle
 * - Custom tools: fully supported via `customTools` (CLI transport warns and ignores)
 * - Custom providers: programmatic via `modelRegistry.registerProvider(name, config)`
 * - Built-in tool gating: static allowlist via `PiConfig.sdkTools` / `sdkNoTools`
 *   (per-call approval is not exposed by the SDK because AgentSession
 *   internally claims `agent.beforeToolCall`)
 *
 * Permission model (v1):
 * - `customTools` registered via CallOptions go through our wrapper around
 *   `execute()`, which honors `tool.needsApproval` + `opts.onPermissionRequest`
 *   exactly like the copilot SDK transport. Built-in pi tools (read/bash/edit/write)
 *   are NOT per-call gated; restrict them statically via `sdkTools` / `sdkNoTools`.
 *
 * Event mapping (pi AgentSessionEvent -> our AgentEvent):
 * - createAgentSession -> session(sessionId)
 * - agent_start -> turn_start()
 * - message_update.assistantMessageEvent.text_delta -> text_delta(...)
 * - tool_execution_start -> tool_call(callId, name, args, "in_progress")
 * - tool_execution_update -> tool_progress(callId, name, partialResult)
 * - tool_execution_end -> tool_result(callId, result, isError, status)
 * - turn_end.message.usage -> usage(...)
 * - agent_end -> turn_end(stopReason) + result(sessionId, finalText, raw)
 * - prompt() rejection -> error(...) + turn_end("error")
 * - abort -> turn_end("cancelled")
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PiConfig,
  StreamOp,
  CallOptions,
  AgentEvent,
  AgentTool,
  PermissionRequest,
} from "../types.js";
import { AgentError, notSupported } from "../errors.js";
import { synthesizeHostHandledResult } from "../tools.js";
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
  usageEvent,
} from "../events.js";

// Minimal structural types of the pi SDK surface we depend on. Avoids a hard
// type-side dependency on `@mariozechner/pi-coding-agent` for consumers that
// only use the CLI transport. The actual values are imported dynamically.
export interface PiAgentSession {
  readonly sessionId: string;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string, options?: { images?: unknown[] }): Promise<void>;
  /** Pi 0.73+: aborts in-flight agent run + waits for idle. */
  abort?: () => Promise<void>;
  dispose(): void;
  readonly modelRegistry: PiModelRegistry;
  readonly state: { messages: Array<Record<string, unknown>> };
}
interface PiModelRegistry {
  registerProvider(name: string, config: unknown): void;
  find(provider: string, modelId: string): unknown;
}
interface PiSessionManager {
  getSessionId(): string;
  newSession(opts?: { id?: string }): string | undefined;
}
interface PiSessionManagerStatic {
  create(cwd: string): PiSessionManager;
  open(filePath: string): PiSessionManager;
  forkFrom(sourcePath: string, targetCwd: string): PiSessionManager;
  list(cwd: string): Promise<Array<{ id: string; path: string }>>;
}

/**
 * Pi `AgentSessionEvent` shape (subset we consume).
 * See `@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts` and
 * `@mariozechner/pi-agent-core/dist/types.d.ts:AgentEvent`.
 */
export type PiSessionEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[] }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: {
        usage?: PiUsage;
        stopReason?: string;
        content?: PiContentPart[];
        errorMessage?: string;
      };
      toolResults: unknown[];
    }
  | { type: "message_start"; message: unknown }
  | {
      type: "message_update";
      message: { id?: string };
      assistantMessageEvent: PiAssistantMessageEvent;
    }
  | { type: "message_end"; message: { id?: string; content?: PiContentPart[] } }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: { content?: PiContentPart[]; details?: unknown };
      isError: boolean;
    }
  // session-extension events we drop
  | { type: "queue_update" }
  | { type: "compaction_start" }
  | { type: "compaction_end" }
  | { type: "session_info_changed" };

type PiAssistantMessageEvent =
  | { type: "text_start" }
  | { type: "text_delta"; delta?: string; content?: string }
  | { type: "text_end"; content?: string }
  | { type: "tool_input_delta"; delta?: string }
  | { type: "thinking_delta"; delta?: string };

type PiContentPart = { type: "text"; text: string } | { type: string; [k: string]: unknown };

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

/**
 * Resolve a session UUID to a session file path within the cwd's session dir.
 */
async function resolveSessionPathByUuid(
  SessionManager: PiSessionManagerStatic,
  cwd: string,
  uuid: string,
): Promise<string | undefined> {
  try {
    const list = await SessionManager.list(cwd);
    const found = list.find((s) => s.id === uuid);
    return found?.path;
  } catch {
    return undefined;
  }
}

/**
 * Build pi `customTools` from our `AgentTool` registry.
 *
 * Each generated tool wraps `execute()` to:
 * 1. Check `needsApproval` and emit a `permission_request` AgentEvent on the
 *    queue, awaiting either an external respond() or `opts.onPermissionRequest`.
 * 2. Pass `signal` through as our `ctx.abortSignal`.
 * 3. Convert our return value to pi's `AgentToolResult` shape:
 *    `{ content: [{ type: "text", text: <stringified> }], details: <raw> }`.
 *
 * The permission flow concentrates here because pi's public SDK does NOT
 * expose `agent.beforeToolCall` for callers (AgentSession internally hijacks
 * that hook). So we only gate the tools we created the wrapper around.
 */
function buildPiCustomTools(
  agentTools: Record<string, AgentTool> | undefined,
  ctx: {
    outerAbortSignal: AbortSignal | undefined;
    emitToolProgress: (callId: string, name: string, update: unknown) => void;
    requestPermission: (request: PermissionRequest) => Promise<{ allow: boolean; reason?: string }>;
  },
): unknown[] {
  if (!agentTools) return [];
  return Object.values(agentTools).map((tool) => {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      // Pass JSON Schema through as TypeBox-shaped parameters. Pi accepts the
      // shape because TypeBox produces JSON-Schema-compatible objects; pi-ai
      // forwards `parameters` to the LLM tool definition without strict
      // TypeBox validation. If pi tightens this in a future version we can
      // wrap with `Type.Unsafe` from @sinclair/typebox.
      parameters: tool.inputSchema,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate?: (update: { content: PiContentPart[]; details: unknown }) => void,
      ): Promise<{
        content: PiContentPart[];
        details: unknown;
      }> => {
        // Approval gate: predicate may be async.
        const needsApproval =
          typeof tool.needsApproval === "function"
            ? await tool.needsApproval(params, {
                sessionId: "", // populated by pi's tool ctx, not ours; keep empty
                abortSignal: signal ?? ctx.outerAbortSignal ?? new AbortController().signal,
              })
            : Boolean(tool.needsApproval);
        if (needsApproval) {
          const request: PermissionRequest = {
            requestId: toolCallId,
            toolName: tool.name,
            details: params,
          };
          const decision = await ctx.requestPermission(request);
          if (!decision.allow) {
            return {
              content: [
                {
                  type: "text",
                  text: `Tool call ${tool.name} denied${decision.reason ? `: ${decision.reason}` : ""}`,
                },
              ],
              details: { denied: true, reason: decision.reason },
            };
          }
        }

        try {
          // Host-handled tool (no `execute`): the host observes the
          // tool_call event and acts post-turn. Synthesize a neutral
          // ack so pi's turn loop can continue. See the AgentTool
          // interface docstring + `synthesizeHostHandledResult`.
          const result =
            typeof tool.execute === "function"
              ? await tool.execute(params, {
                  sessionId: "",
                  abortSignal: signal ?? ctx.outerAbortSignal ?? new AbortController().signal,
                  emit: (update: unknown) => {
                    ctx.emitToolProgress(toolCallId, tool.name, update);
                    if (onUpdate) {
                      const text = typeof update === "string" ? update : safeStringify(update);
                      onUpdate({
                        content: [{ type: "text", text }],
                        details: update,
                      });
                    }
                  },
                })
              : synthesizeHostHandledResult(params);
          const text = typeof result === "string" ? result : safeStringify(result);
          return {
            content: [{ type: "text", text }],
            details: result,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Pi treats AgentToolResult with an error-flag through the `isError`
          // field on the agent's tool-result event. The handler return alone
          // doesn't carry that; the agent infers error from a thrown handler.
          // Re-throw so pi marks it as isError=true in tool_execution_end.
          throw new Error(message);
        }
      },
    };
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert pi's `usage` object into our `usageEvent` arguments.
 */
function mapUsage(usage: PiUsage | undefined): AgentEvent | undefined {
  if (!usage) return undefined;
  return usageEvent({
    inputTokens: typeof usage.input === "number" ? usage.input : undefined,
    outputTokens: typeof usage.output === "number" ? usage.output : undefined,
    cachedReadTokens: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
    cachedWriteTokens: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
    totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
    costUsd: typeof usage.cost?.total === "number" ? (usage.cost.total as number) : undefined,
  });
}

/**
 * Stream a single op against a pi session via the programmatic SDK.
 *
 * Implementation uses a concurrent event pump (event queue + waker) so that
 * permission requests surfaced from within a tool's `execute()` are delivered
 * to the iterator BEFORE the tool's promise resolves. Without this, awaiting
 * `session.prompt()` first would deadlock because the outer iterator wouldn't
 * receive the permission_request event in time to respond.
 */
export async function* _streamPiSdk(
  op: StreamOp,
  opts: CallOptions,
  ctx: { cwd: string; config?: PiConfig },
): AsyncIterable<AgentEvent> {
  // Lazy-load the SDK; if missing, surface a clear error.
  let sdk: typeof import("@mariozechner/pi-coding-agent");
  let pia: typeof import("@mariozechner/pi-ai");
  try {
    sdk = await import("@mariozechner/pi-coding-agent");
    pia = await import("@mariozechner/pi-ai");
  } catch (err) {
    throw new AgentError(
      "not_supported",
      `Pi SDK transport requires '@mariozechner/pi-coding-agent' and '@mariozechner/pi-ai' to be installed as peer dependencies. Original error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } = sdk as unknown as {
    createAgentSession: unknown;
    SessionManager: unknown;
    AuthStorage: { create: (path?: string) => unknown };
    ModelRegistry: {
      create: (
        authStorage: unknown,
        modelsJsonPath?: string,
      ) => {
        find: (provider: string, modelId: string) => unknown;
        hasConfiguredAuth: (model: unknown) => boolean;
      };
    };
  };
  const { getModel } = pia;

  // Sandbox: fail closed. The SDK transport runs in-process, so there is no
  // subprocess to wrap with `nono`. A caller who configured sandbox AND chose
  // transport: "sdk" is silently bypassing their safety boundary — throw
  // instead. Use transport: "cli" if you need sandboxing.
  if (ctx.config?.sandbox) {
    throw notSupported(
      "Pi SDK transport does not support sandbox (in-process execution). Use transport: 'cli' for sandboxed runs.",
      "sandbox_unsupported_sdk",
    );
  }

  // Per-op constraints
  if (op.kind === "resume" && op.atMessageId) {
    throw notSupported(
      "Pi SDK transport does not yet support resume at a specific message id.",
      "resume_at_unsupported",
    );
  }
  if (op.kind === "fork" && op.atMessageId) {
    throw notSupported(
      "Pi SDK transport does not yet support fork at a specific message id.",
      "fork_at_unsupported",
    );
  }

  // mcpServers: not supported on SDK transport (warn-once is harder per-op;
  // throw clearly if user tries to pass servers here).
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    throw notSupported(
      "Pi SDK transport does not currently support CallOptions.mcpServers. Use pi extensions for MCP integration.",
      "mcp_unsupported",
    );
  }

  // Resolve model. Format we accept: "<provider>/<modelId>" or
  // <modelId> alone if config.provider is set or pi can resolve it.
  const modelSpec = opts.model ?? ctx.config?.model ?? "";
  const provider = ctx.config?.provider;
  let resolvedProvider: string | undefined;
  let resolvedModelId: string | undefined;
  if (modelSpec.includes("/")) {
    const idx = modelSpec.indexOf("/");
    resolvedProvider = modelSpec.slice(0, idx);
    resolvedModelId = modelSpec.slice(idx + 1);
  } else if (modelSpec && provider) {
    resolvedProvider = provider;
    resolvedModelId = modelSpec;
  } else if (modelSpec) {
    // Bare modelId without provider — caller must rely on pi's default
    // provider resolution. We pass undefined and let pi pick from settings.
    resolvedModelId = modelSpec;
  }

  // Build the model registry up front and resolve the model THROUGH it so
  // that provider-specific auth (e.g. github-copilot OAuth from ~/.pi/agent/
  // auth.json) is wired into the returned `Model` object. Calling
  // `getModel(provider, id)` directly from pi-ai returns a static descriptor
  // with no auth attached — the upstream call then returns 421 Misdirected
  // Request because no credentials reach the wire. We construct the
  // registry, look up the model with `find()`, and pass BOTH into
  // createAgentSession so its internal resolution path matches the CLI's.
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // Register custom providers BEFORE model resolution so callers can use
  // `opts.model = "<customProvider>/<modelId>"` — otherwise modelRegistry.find()
  // would fail, the fallback static getModel() would miss the custom shape,
  // and hasConfiguredAuth() would run before the provider's auth is registered.
  const registeredCustomProviderNames: string[] = [];
  if (ctx.config?.customProviders) {
    for (const cp of ctx.config.customProviders) {
      try {
        (
          modelRegistry as unknown as {
            registerProvider: (name: string, config: unknown) => void;
          }
        ).registerProvider(cp.name, cp.config);
        registeredCustomProviderNames.push(cp.name);
      } catch (err) {
        throw new AgentError(
          "invalid_input",
          `Pi SDK transport: failed to register custom provider "${cp.name}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  let model: unknown;
  if (resolvedProvider && resolvedModelId) {
    model = modelRegistry.find(resolvedProvider, resolvedModelId);
    if (!model) {
      // Fall back to pi-ai's static lookup so users get a clear "not found"
      // error rather than a silent default-model fallback.
      try {
        model = (getModel as (p: string, m: string) => unknown)(resolvedProvider, resolvedModelId);
      } catch (err) {
        throw new AgentError(
          "invalid_input",
          `Pi SDK transport: model "${resolvedProvider}/${resolvedModelId}" not found in pi-ai registry. ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (model && !modelRegistry.hasConfiguredAuth(model)) {
      throw new AgentError(
        "invalid_input",
        `Pi SDK transport: model "${resolvedProvider}/${resolvedModelId}" has no configured auth. Run \`pi auth login ${resolvedProvider}\` or configure ~/.pi/agent/auth.json.`,
      );
    }
  }

  // SessionManager construction by op kind.
  let sessionManager: PiSessionManager | undefined;
  let pendingForkSourceId: string | undefined;
  switch (op.kind) {
    case "start": {
      sessionManager = (SessionManager as unknown as PiSessionManagerStatic).create(ctx.cwd);
      if (op.pinnedSessionId) {
        sessionManager.newSession({ id: op.pinnedSessionId });
      }
      break;
    }
    case "resume": {
      if (!op.sessionId) {
        throw new AgentError("invalid_input", "resume requires a sessionId");
      }
      let sessionPath: string | undefined;
      if (path.isAbsolute(op.sessionId) && fs.existsSync(op.sessionId)) {
        sessionPath = op.sessionId;
      } else {
        sessionPath = await resolveSessionPathByUuid(
          SessionManager as unknown as PiSessionManagerStatic,
          ctx.cwd,
          op.sessionId,
        );
      }
      if (!sessionPath) {
        throw new AgentError(
          "not_found",
          `Pi SDK transport: session "${op.sessionId}" not found in ${ctx.cwd}`,
        );
      }
      sessionManager = (SessionManager as unknown as PiSessionManagerStatic).open(sessionPath);
      break;
    }
    case "fork": {
      if (!op.sourceSessionId) {
        throw new AgentError("invalid_input", "fork requires a sourceSessionId");
      }
      let sourcePath: string | undefined;
      if (path.isAbsolute(op.sourceSessionId) && fs.existsSync(op.sourceSessionId)) {
        sourcePath = op.sourceSessionId;
      } else {
        sourcePath = await resolveSessionPathByUuid(
          SessionManager as unknown as PiSessionManagerStatic,
          ctx.cwd,
          op.sourceSessionId,
        );
      }
      if (!sourcePath) {
        throw new AgentError(
          "not_found",
          `Pi SDK transport: source session "${op.sourceSessionId}" not found.`,
        );
      }
      pendingForkSourceId = op.sourceSessionId;
      sessionManager = (SessionManager as unknown as PiSessionManagerStatic).forkFrom(
        sourcePath,
        ctx.cwd,
      );
      break;
    }
    default:
      throw new AgentError("invalid_input", `Unknown op kind: ${(op as StreamOp).kind}`);
  }

  // Build a driver: owns the shared event queue + permission plumbing so
  // customTools and the iterator stream both push/pull from the same place.
  const driver = _createSdkDriver(opts);
  const customTools = buildPiCustomTools(opts.tools, {
    outerAbortSignal: opts.abortSignal,
    emitToolProgress: driver.emitToolProgress,
    requestPermission: driver.requestPermission,
  });

  // Build createAgentSession options
  type CreateOpts = {
    cwd: string;
    sessionManager?: unknown;
    authStorage?: unknown;
    modelRegistry?: unknown;
    model?: unknown;
    customTools?: unknown[];
    tools?: string[];
    noTools?: "all" | "builtin";
    thinkingLevel?: PiConfig["thinkingLevel"];
  };
  const createOpts: CreateOpts = {
    cwd: ctx.cwd,
    sessionManager: sessionManager as unknown,
    authStorage,
    modelRegistry,
  };
  if (model) createOpts.model = model;
  if (customTools.length > 0) createOpts.customTools = customTools;
  if (ctx.config?.sdkTools) createOpts.tools = ctx.config.sdkTools;
  if (ctx.config?.sdkNoTools) createOpts.noTools = ctx.config.sdkNoTools;
  if (ctx.config?.thinkingLevel) createOpts.thinkingLevel = ctx.config.thinkingLevel;

  let session: PiAgentSession | undefined;

  try {
    const created = (await (
      createAgentSession as unknown as (o: CreateOpts) => Promise<{ session: PiAgentSession }>
    )(createOpts)) as { session: PiAgentSession };
    session = created.session;

    const sessionId = session.sessionId;

    // Emit session lifecycle events FIRST so consumers see them before any
    // turn content. session_forked is emitted only for fork ops, before the
    // primary session event (mirroring opencode/copilot transports).
    yield sessionEvent(sessionId);
    if (op.kind === "fork" && pendingForkSourceId) {
      yield sessionForkedEvent(sessionId, pendingForkSourceId);
    }

    yield* driver.run(session, op);
  } finally {
    if (session) {
      try {
        session.dispose();
      } catch {
        // ignore
      }
    }
    // Unregister custom providers we registered this run so they don't leak
    // into other Pi SDK calls sharing this process. registerProvider applies
    // OAuth/API config globally (see node_modules/@mariozechner/pi-coding-agent/
    // dist/core/model-registry.js:666-680); without cleanup, the next call's
    // ModelRegistry instance inherits these registrations.
    for (const name of registeredCustomProviderNames) {
      try {
        (
          modelRegistry as unknown as { unregisterProvider?: (name: string) => void }
        ).unregisterProvider?.(name);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * SDK driver: owns the shared event queue + permission/progress plumbing.
 *
 * Custom tools wrap calls to `requestPermission` / `emitToolProgress`, and
 * the iterator returned by `run()` drains the same queue. Exported for unit
 * testing — tests can construct a driver, build customTools against it,
 * push synthetic events through `pushSdkEvent`/`completePrompt`, and assert
 * event mapping in isolation.
 */
export interface SdkDriver {
  emitToolProgress: (callId: string, name: string, update: unknown) => void;
  requestPermission: (request: PermissionRequest) => Promise<{
    allow: boolean;
    reason?: string;
  }>;
  run: (session: PiAgentSession, op: StreamOp) => AsyncIterable<AgentEvent>;
}

export function _createSdkDriver(opts: CallOptions): SdkDriver {
  type QueueItem =
    | { kind: "sdk"; event: PiSessionEvent }
    | { kind: "agent"; event: AgentEvent }
    | { kind: "cancelled" }
    | { kind: "done" }
    | { kind: "error"; error: Error };
  const eventQueue: QueueItem[] = [];
  let queueResolve: (() => void) | undefined;
  const queuePromise = () =>
    new Promise<void>((resolve) => {
      queueResolve = resolve;
    });
  const notifyQueue = () => {
    const r = queueResolve;
    if (r) {
      queueResolve = undefined;
      r();
    }
  };

  const emitToolProgress = (callId: string, name: string, update: unknown): void => {
    eventQueue.push({ kind: "agent", event: toolProgressEvent(callId, name, update) });
    notifyQueue();
  };

  const requestPermission = async (
    request: PermissionRequest,
  ): Promise<{ allow: boolean; reason?: string }> => {
    let resolveDecision: (d: { allow: boolean; reason?: string }) => void = () => {};
    const decisionPromise = new Promise<{ allow: boolean; reason?: string }>((r) => {
      resolveDecision = r;
    });
    const respond = async (
      decision: "allow" | "deny",
      _opts2?: { persist?: boolean },
    ): Promise<void> => {
      // PermissionDecision.persist is dropped on the pi SDK transport: pi
      // has no per-tool always-allow surface accessible via public SDK.
      resolveDecision({ allow: decision === "allow" });
    };
    eventQueue.push({
      kind: "agent",
      event: permissionRequestEvent(request.requestId, request.toolName, request.details, {
        respond,
      }),
    });
    notifyQueue();
    if (opts.onPermissionRequest) {
      const result = await Promise.resolve(opts.onPermissionRequest(request));
      if (result.decision === "allow") {
        resolveDecision({ allow: true });
      } else {
        resolveDecision({
          allow: false,
          reason: "reason" in result ? result.reason : undefined,
        });
      }
    }
    return decisionPromise;
  };

  async function* run(session: PiAgentSession, op: StreamOp): AsyncIterable<AgentEvent> {
    let abortListener: (() => void) | undefined;
    let agentEndSeen = false;
    let promptFailsafeTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = session.subscribe((event) => {
      eventQueue.push({ kind: "sdk", event: event as PiSessionEvent });
      notifyQueue();
    });

    const triggerAbort = () => {
      // Push the cancelled marker so the drain loop yields exactly ONE
      // turn_end(cancelled) + result and breaks. Then ask pi to actually
      // cancel its in-flight run via the public abort() API (0.73+); fall
      // back to dispose() if abort is unavailable. Errors from abort are
      // ignored — we've already enqueued cancellation for the consumer.
      eventQueue.push({ kind: "cancelled" });
      notifyQueue();
      void (async () => {
        try {
          if (typeof session.abort === "function") {
            await session.abort();
          }
        } catch {
          // ignore
        }
        try {
          session.dispose();
        } catch {
          // ignore
        }
      })();
    };

    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        triggerAbort();
      } else {
        abortListener = triggerAbort;
        opts.abortSignal.addEventListener("abort", abortListener, { once: true });
      }
    }

    // Drive prompt() concurrently with event drain — awaiting prompt() before
    // draining would deadlock customTool permission flows because the
    // permission roundtrip needs the iterator consumer to call respond().
    //
    // IMPORTANT: prompt() resolves AFTER pi's internal turn machinery
    // returns, but pi's event listeners are notified via a separate async
    // queue. The final `agent_end` event can arrive AFTER prompt() resolves.
    // If we eagerly push `done` on prompt resolution we may emit a synthetic
    // turn_end + result before the real `agent_end` lands. Instead, treat
    // agent_end as the canonical completion signal and only use a delayed
    // failsafe when prompt resolves without an agent_end ever arriving.
    const promptPromise = session
      .prompt(op.prompt)
      .then(() => {
        if (agentEndSeen) return;
        promptFailsafeTimer = setTimeout(() => {
          if (agentEndSeen) return;
          eventQueue.push({ kind: "done" });
          notifyQueue();
        }, 100);
      })
      .catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        eventQueue.push({ kind: "error", error: e });
        notifyQueue();
      });
    void promptPromise;

    let turnStarted = false;
    let turnEnded = false;
    let resultEmitted = false;
    let finalText: string | undefined;
    let accumulatedText = "";
    let lastStopReason: string | undefined;
    let lastTurnEndRaw: unknown = undefined;

    const sessionId = session.sessionId;

    try {
      while (true) {
        while (eventQueue.length === 0) {
          await queuePromise();
        }
        const item = eventQueue.shift()!;

        if (item.kind === "cancelled") {
          if (!turnEnded) {
            yield turnEndEvent("cancelled");
            turnEnded = true;
          }
          if (!resultEmitted) {
            yield resultEvent(sessionId, finalText ?? accumulatedText, lastTurnEndRaw);
            resultEmitted = true;
          }
          break;
        }
        if (item.kind === "done") {
          if (!turnEnded) {
            yield turnEndEvent(normalizeStopReason(lastStopReason) ?? "end_turn");
            turnEnded = true;
          }
          if (!resultEmitted) {
            yield resultEvent(sessionId, finalText ?? accumulatedText, lastTurnEndRaw);
            resultEmitted = true;
          }
          break;
        }
        if (item.kind === "error") {
          yield errorEvent(item.error.message, "pi_sdk_error", { error: item.error });
          if (!turnEnded) {
            yield turnEndEvent("error");
            turnEnded = true;
          }
          if (!resultEmitted) {
            yield resultEvent(sessionId, finalText ?? accumulatedText, undefined);
            resultEmitted = true;
          }
          break;
        }
        if (item.kind === "agent") {
          yield item.event;
          continue;
        }

        const ev = item.event;
        yield rawEvent("pi", ev);

        switch (ev.type) {
          case "agent_start": {
            if (!turnStarted) {
              yield turnStartEvent();
              turnStarted = true;
            }
            break;
          }
          case "message_update": {
            const ame = ev.assistantMessageEvent;
            if (ame && ame.type === "text_delta") {
              const delta =
                typeof (ame as { delta?: string }).delta === "string"
                  ? (ame as { delta?: string }).delta
                  : undefined;
              if (delta) {
                accumulatedText += delta;
                yield textDeltaEvent(delta, ev.message?.id);
              }
            }
            break;
          }
          case "tool_execution_start": {
            yield toolCallEvent(ev.toolCallId, ev.toolName, ev.args, "in_progress");
            break;
          }
          case "tool_execution_update": {
            yield toolProgressEvent(ev.toolCallId, ev.toolName, ev.partialResult);
            break;
          }
          case "tool_execution_end": {
            const isError = Boolean(ev.isError);
            const status = isError ? "failed" : "completed";
            const output =
              ev.result?.content && ev.result.content.length > 0 ? ev.result.content : ev.result;
            yield toolResultEvent(ev.toolCallId, output, isError, status as "completed" | "failed");
            break;
          }
          case "turn_end": {
            lastTurnEndRaw = ev;
            lastStopReason = ev.message?.stopReason ?? lastStopReason;
            const content = ev.message?.content;
            if (Array.isArray(content)) {
              const textParts = content
                .filter((c): c is { type: "text"; text: string } => c?.type === "text")
                .map((c) => c.text)
                .join("");
              if (textParts) {
                finalText = textParts;
              }
            }
            // Pi surfaces upstream model errors via stopReason="error" +
            // errorMessage on turn_end.message rather than throwing from
            // prompt(). Emit them as an error event so callers see the
            // failure reason instead of a silent empty result.
            if (lastStopReason === "error" && ev.message?.errorMessage) {
              yield errorEvent(ev.message.errorMessage, "pi_sdk_model_error", {
                provider: (ev.message as Record<string, unknown>).provider,
                model: (ev.message as Record<string, unknown>).model,
              });
            }
            const u = mapUsage(ev.message?.usage);
            if (u) yield u;
            break;
          }
          case "agent_end": {
            agentEndSeen = true;
            if (!turnEnded) {
              yield turnEndEvent(normalizeStopReason(lastStopReason) ?? "end_turn");
              turnEnded = true;
            }
            if (!resultEmitted) {
              yield resultEvent(sessionId, finalText ?? accumulatedText, lastTurnEndRaw ?? ev);
              resultEmitted = true;
            }
            break;
          }
          default:
            break;
        }

        if (resultEmitted) {
          break;
        }
      }
    } finally {
      if (promptFailsafeTimer) {
        clearTimeout(promptFailsafeTimer);
      }
      if (abortListener && opts.abortSignal) {
        try {
          opts.abortSignal.removeEventListener("abort", abortListener);
        } catch {
          // ignore
        }
      }
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
  }

  return { emitToolProgress, requestPermission, run };
}

// Pi emits "aborted" for cancelled runs; our public taxonomy uses "cancelled".
function normalizeStopReason(reason: string | undefined): string | undefined {
  if (reason === "aborted") return "cancelled";
  return reason;
}

// Generate a synthetic call id (used only for defensive paths where pi did
// not provide a toolCallId).
export function _syntheticCallId(): string {
  return `pi-sdk-${randomUUID()}`;
}
