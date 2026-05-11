// Per-provider factories
export type ProviderName = "claude" | "copilot" | "opencode" | "pi" | "acp";
export type TransportKind = "cli" | "sdk" | "acp" | "rpc";

// Attachment types
export type Attachment =
  | { type: "file"; path: string }
  | { type: "image"; data: Uint8Array; mimeType: string }
  | { type: "image_url"; url: string }
  | { type: "resource"; name: string; mimeType?: string; content: string };

// ACP-style content part
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: "audio"; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };

// Per-call options
export interface CallOptions {
  abortSignal?: AbortSignal;
  attachments?: Attachment[];
  parts?: ContentPart[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  /**
   * Per-call model override. When set, takes precedence over the provider's
   * construction-time `config.model`. Format is provider-specific:
   *   - claude: model id (e.g. `"claude-sonnet-4-5"`) — passed as `--model`.
   *   - copilot SDK: model id passed to the SDK's `createSession` /
   *     `resumeSession` config; on resume the override applies to the next
   *     turn (no in-place model swap).
   *   - opencode SDK: `"providerID/modelID"` (e.g. `"github-copilot/gpt-4o"`)
   *     or just `modelID` (defaults provider to `github-copilot`).
   *   - pi: model id — passed as `--model`.
   *   - acp: ignored (no model concept in the protocol).
   */
  model?: string;
  tools?: Record<string, AgentTool>;
  mcpServers?: McpServerConfig[];
  onPermissionRequest?: (
    req: PermissionRequest,
  ) => Promise<PermissionDecision> | PermissionDecision;
  providerOptions?: {
    claude?: { maxBudgetUsd?: number };
    copilot?: {
      reasoningEffort?: "low" | "medium" | "high" | "xhigh";
    };
    pi?: { mode?: "json" | "rpc"; fork?: boolean; experimentalFork?: boolean };
  };
}

// Result of a completed turn
export interface SessionResult {
  sessionId: string;
  text: string;
  provider: ProviderName;
  raw: unknown;
}

// Event base with _meta extension bag
export interface EventBase {
  _meta?: Record<string, unknown>;
}

// Usage info
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

// Full event taxonomy — aligned with ACP session/update kinds
export type AgentEvent = EventBase &
  (
    | // Session lifecycle
      { type: "session"; sessionId: string }
    | { type: "session_forked"; sessionId: string; sourceSessionId: string }
    | { type: "turn_start" }
    | { type: "turn_end"; stopReason: "end_turn" | "max_tokens" | "cancelled" | "error" | string }

    // Model & capabilities
    | { type: "model_info"; currentModel: string; available?: Array<{ id: string; name: string }> }
    | { type: "available_commands"; commands: Array<{ name: string; description?: string }> }

    // Messages
    | { type: "user_message"; text: string; messageId?: string }
    | { type: "text_delta"; delta: string; messageId?: string }
    | { type: "thinking_delta"; delta: string; messageId?: string }
    | { type: "assistant_message"; text: string; messageId?: string }

    // Generic tools
    | {
        type: "tool_call";
        callId: string;
        name: string;
        input: unknown;
        status?: "pending" | "in_progress";
        toolKind?:
          | "read"
          | "edit"
          | "delete"
          | "move"
          | "search"
          | "execute"
          | "think"
          | "fetch"
          | "subagent"
          | "other"
          | string;
        subagent?: { subagentId: string; childSessionId?: string; agentName?: string };
      }
    | {
        type: "tool_result";
        callId: string;
        output: unknown;
        isError?: boolean;
        status: "completed" | "failed" | "cancelled";
      }
    | {
        type: "tool_progress";
        callId: string;
        name: string;
        update: unknown;
      }

    // Specialized
    | {
        type: "command_exec";
        callId: string;
        command: string;
        cwd?: string;
        status: "started" | "running" | "completed" | "failed";
        stdout?: string;
        stderr?: string;
        exitCode?: number;
      }
    | {
        type: "file_change";
        callId: string;
        path: string;
        operation: "create" | "update" | "delete";
        patch?: string;
        status: "proposed" | "applied" | "rejected";
      }
    | {
        type: "web_search";
        callId: string;
        query: string;
        results?: Array<{ url: string; title?: string; snippet?: string }>;
      }
    | {
        type: "todo_update";
        items: Array<{ id: string; text: string; status: "pending" | "in_progress" | "done" }>;
      }

    // Permission
    | {
        type: "permission_request";
        requestId: string;
        toolName: string;
        details: unknown;
        annotations?: {
          readOnlyHint?: boolean;
          destructiveHint?: boolean;
          openWorldHint?: boolean;
          justification?: string;
        };
        respond?: (decision: "allow" | "deny", opts?: { persist?: boolean }) => Promise<void>;
      }

    // Usage
    | {
        type: "usage";
        inputTokens?: number;
        outputTokens?: number;
        cachedReadTokens?: number;
        cachedWriteTokens?: number;
        thoughtTokens?: number;
        totalTokens?: number;
        contextUsed?: number;
        contextSize?: number;
        costUsd?: number;
      }

    // Terminal
    | {
        type: "result";
        sessionId: string;
        text: string;
        stopReason?: string;
        usage?: AgentUsage;
        raw: unknown;
      }
    | { type: "error"; message: string; code?: string; raw?: unknown }

    // Extension + raw
    | { type: "extension"; namespace: string; kind: string; data: unknown }
    | { type: "raw"; source: ProviderName; raw: unknown }
  );

// Fork options
//
// Currently identical to CallOptions. Kept as a distinct type so providers
// can add fork-specific fields (e.g. event boundaries) without a breaking
// change once a provider actually consumes them.
export type ForkOptions = CallOptions;

// Permission types
export interface PermissionRequest {
  requestId: string;
  toolName: string;
  details: unknown;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
    justification?: string;
  };
}
export type PermissionDecision =
  | {
      decision: "allow";
      /**
       * Whether to persist the approval for the rest of the session.
       * - opencode SDK: honored (maps to "always"/"once").
       * - ACP: best-effort — honored if the server offers a matching
       *   "allow_always" option among `params.options` (see
       *   `PermissionOption.kind` in @zed-industries/agent-client-protocol).
       *   Falls back to one-shot allow when no such option is present.
       * - Copilot SDK: currently ignored pending SDK support (the
       *   PermissionDecision type has no always/scope field).
       * - Claude CLI: N/A (no per-call hook).
       */
      persist?: boolean;
    }
  | { decision: "deny"; reason?: string };

/** Context passed to a tool's `execute` function. */
export interface ToolContext {
  sessionId: string;
  abortSignal: AbortSignal;
  /**
   * Optional emit hook populated by providers that surface intermediate
   * progress updates (from async-generator tools). Undefined when the
   * provider has no progress channel.
   */
  emit?: (update: unknown) => void;
}

// Agent tool — the low-level runtime shape consumed by provider transports.
// `execute` always resolves to a single value. User-facing tool definitions
// (see `ToolDefinition` in src/tools.ts) additionally accept async generators;
// the `tool()` helper normalizes those to this shape.
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * When truthy (or predicate returns true), the wrapper emits a
   * permission_request event via ctx.emit BEFORE calling execute(). The tool
   * runs only when the request is approved via respond("allow") or the
   * ctx.onPermissionRequest callback returns allow. Applies only on
   * transports that populate ctx.emit (currently: copilot SDK).
   */
  needsApproval?: boolean | ((input: unknown, ctx: ToolContext) => boolean | Promise<boolean>);
  execute: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

// Agent info for detectAgents()
export interface AgentInfo {
  available: boolean;
  version?: string;
  binPath?: string;
  sdk?: boolean;
  warnings?: string[];
  capabilities?: {
    acp: boolean;
    mcp: { stdio: boolean; http: boolean };
    sessionFork: boolean;
    sdk: boolean;
    customTools: boolean;
    attachments: boolean;
  };
}

// Provider configs
export interface ClaudeConfig {
  cwd?: string;
  model?: string;
  binPath?: string;
  transport?: "cli";
  via?: "native" | "copilot-api";
  copilotApi?: {
    baseUrl?: string;
    daemon?: "auto" | "reuse" | "managed";
    model?: string;
    startCommand?: string[];
  };
  mcpServers?: McpServerConfig[];
  sandbox?: SandboxConfig;
}

export interface CopilotConfig {
  cwd?: string;
  model?: string;
  binPath?: string;
  githubToken?: string;
  allowAllTools?: boolean;
  mcpServers?: McpServerConfig[];
  sandbox?: SandboxConfig;
  tools?: Record<string, AgentTool>;
}

export interface OpencodeConfig {
  cwd?: string;
  model?: string;
  binPath?: string;
  agent?: string;
  serverPort?: number;
  mcpServers?: McpServerConfig[];
  sandbox?: SandboxConfig;
}

/**
 * Per-call options to register custom providers when running the pi SDK
 * transport. Each entry calls `modelRegistry.registerProvider(name, config)`
 * before the first prompt.
 *
 * The `config` value is passed through to pi-ai's `registerProvider` API; it
 * is typed as `unknown` here so callers without `@mariozechner/pi-coding-agent`
 * installed don't pay a type-resolution cost. See pi's
 * `ProviderConfigInput` (in `@mariozechner/pi-coding-agent/dist/core/model-registry.d.ts`)
 * for the accepted fields (`baseUrl`, `apiKey`, `api`, `headers`, `oauth`,
 * `models`, `streamSimple`, etc).
 */
export interface PiCustomProvider {
  name: string;
  config: unknown;
}

export interface PiConfig {
  cwd?: string;
  model?: string;
  provider?: string;
  binPath?: string;
  /**
   * Transport selection.
   * - `"cli"` (default): spawn the `pi` binary and parse JSONL output. No JS
   *   peer dependency required.
   * - `"sdk"`: use `@mariozechner/pi-coding-agent` programmatically (peer
   *   dep, optional). Unlocks custom tools, programmatic custom providers,
   *   and in-process execution.
   * - `"rpc"`: not yet supported (falls back to cli with a warning).
   */
  transport?: "cli" | "sdk" | "rpc";
  extensions?: string[];
  /**
   * SDK transport only. Static allowlist of pi built-in tool names to expose
   * (e.g. `["read", "bash"]`). When omitted, pi's defaults apply
   * (`["read", "bash", "edit", "write"]`).
   */
  sdkTools?: string[];
  /**
   * SDK transport only. Disable some/all built-in tools.
   * - `"all"`: no built-in tools enabled (only `customTools` from CallOptions)
   * - `"builtin"`: disable read/bash/edit/write but keep extension/custom tools
   */
  sdkNoTools?: "all" | "builtin";
  /**
   * SDK transport only. Custom providers to register on the session's
   * ModelRegistry before the first prompt. See `PiCustomProvider` for shape.
   */
  customProviders?: PiCustomProvider[];
  /**
   * SDK transport only. Pi `ThinkingLevel` (`"off"|"minimal"|"low"|"medium"|"high"|"xhigh"`).
   * Pi clamps to model capabilities; unsupported values are downgraded.
   */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  sandbox?: SandboxConfig;
}

export interface AcpConfig {
  spawn: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Default model id to select via the ACP `session/set_model` RPC. Only
   * honored when the agent advertises model selection support
   * (`NewSessionResponse.models` is non-null). Per the ACP schema this
   * capability is **UNSTABLE** ("not part of the spec yet, and may be removed
   * or changed at any point"). Per-call `opts.model` overrides this.
   */
  model?: string;
  sandbox?: SandboxConfig;
}

// MCP server config
export interface McpServerConfig {
  name: string;
  transport:
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
    | { type: "http"; url: string; headers?: Record<string, string> }
    | { type: "sse"; url: string; headers?: Record<string, string> }
    | { type: "acp" };
  tools?: { allow?: string[]; deny?: string[] };
  timeoutMs?: number;
  _meta?: Record<string, unknown>;
}

// Sandbox config
export interface SandboxPolicy {
  filesystem?: {
    read?: string[];
    write?: string[];
    deny?: string[];
  };
  network?: "deny" | { allow: string[]; proxy?: boolean };
  env?: {
    strip?: string[] | "*";
    keep?: string[];
  };
}

export interface SandboxConfig {
  mode?:
    | "none"
    | "cwd"
    | "paranoid"
    | { nonoProfile: string }
    | { nonoProfileFile: string }
    | SandboxPolicy;
  nonoBinPath?: string;
  failIfUnavailable?: boolean;
}

// Create agent options
//
// NOTE: Sandbox is a provider-lifecycle concern and is configured on the
// provider factory (e.g. `claude({ sandbox: ... })`, `copilot({ sandbox: ... })`),
// not here. Threading it through the agent-level options would either duplicate
// provider state or silently shadow provider-level settings, so it is intentionally
// omitted from CreateAgentOptions.
export interface CreateAgentOptions {
  provider: Provider;
  onPermissionRequest?: (
    req: PermissionRequest,
  ) => Promise<PermissionDecision> | PermissionDecision;
  tools?: Record<string, AgentTool>;
  mcpServers?: McpServerConfig[];
  systemPrompt?: string;
  abortSignal?: AbortSignal;
}

// Internal provider contract
export interface ProviderImpl {
  readonly name: ProviderName;
  readonly transport: TransportKind;
  stream(op: StreamOp, opts: CallOptions): AgentStream;
  dispose(): Promise<void>;
  deleteSession?(sessionId: string): Promise<void>;
}

// Discriminated union of stream operations. Narrow on `op.kind` before
// reading kind-specific fields like `sessionId` or `sourceSessionId`.
export type StreamOp =
  | {
      kind: "start";
      prompt: string;
      attachments?: Attachment[];
      pinnedSessionId?: string;
    }
  | {
      kind: "resume";
      sessionId: string;
      prompt: string;
      attachments?: Attachment[];
      atMessageId?: string;
    }
  | {
      kind: "fork";
      sourceSessionId: string;
      prompt: string;
      attachments?: Attachment[];
      atMessageId?: string;
    };

// AgentStream is the async iterable of events from a provider
export type AgentStream = AsyncIterable<AgentEvent>;

// Provider is the opaque type returned by factory functions
export type Provider = ProviderImpl;

/**
 * An Agent wraps a single underlying provider/transport pair and exposes a
 * uniform streaming API.
 *
 * Lifecycle is controlled via `options` on the single `prompt()` method:
 * - `agent.run({ prompt: "hi" })` — start a new session
 * - `agent.run({ prompt: "more", options: { resume } })` — continue a session
 * - `agent.run({ prompt: "more", options: { resume, forkSession: true } })` — branch
 * - `agent.run({ prompt: "more", options: { resume, resumeSessionAt } })` — resume at a message
 * - `agent.run({ prompt: "hi", options: { sessionId } })` — pin a UUID for the new session
 *
 * AbortSignal contract: AbortSignal cancellation is best-effort. The wrapper
 * will signal the underlying process and stop emitting events; callers should
 * still await the stream's `result` (or iterate to completion / call `abort()`)
 * to ensure resource cleanup (temp files, subprocesses) finishes.
 */
export interface Agent extends AsyncDisposable {
  readonly provider: ProviderName;
  readonly transport: TransportKind;
  run(input: RunInput): AgentStreamResult;
  deleteSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/**
 * A user message that can be streamed into `prompt` via an `AsyncIterable`
 * to support multi-turn streaming-input mode (Claude SDK compatibility).
 *
 * Streaming-input mode is not yet implemented in any transport; passing an
 * `AsyncIterable<UserMessage>` to `prompt` currently throws
 * `AgentError("not_supported")`.
 */
export interface UserMessage {
  type: "user";
  content: string | ContentPart[];
}

/**
 * Single object argument for `agent.run()`. Mirrors Claude Code SDK's
 * `query({ prompt, options })` signature.
 */
export interface RunInput {
  prompt: string | AsyncIterable<UserMessage>;
  options?: RunOptions;
}

/**
 * Options for `agent.run()`. Extends `CallOptions` with lifecycle controls
 * mirroring `@anthropic-ai/claude-agent-sdk`.
 *
 * Not every transport supports every option; passing an unsupported option
 * throws `AgentError("not_supported", …)` with a message naming the offending
 * option and transport. See README's "capability matrix" for what each
 * transport honors.
 */
export interface RunOptions extends CallOptions {
  /** Resume the session with this id. */
  resume?: string;
  /** Resume at a specific message UUID within the session. Requires `resume`. */
  resumeSessionAt?: string;
  /**
   * When set together with `resume`, branch the source session into a new
   * session whose history is initialized from the source. The new session's
   * id is independent of the source.
   */
  forkSession?: boolean;
  /** Pin a specific UUID for the new session instead of letting the provider auto-generate. */
  sessionId?: string;
}

// AgentStreamResult — return value of start/resume/fork
export interface AgentStreamResult extends AsyncIterable<AgentEvent> {
  readonly sessionId: Promise<string>;
  readonly text: Promise<string>;
  readonly result: Promise<SessionResult>;
  readonly usage: Promise<AgentUsage | undefined>;
  readonly fullStream: AsyncIterable<AgentEvent>;
  readonly textStream: AsyncIterable<string>;
  [Symbol.asyncIterator](): AsyncIterator<AgentEvent>;
  abort(reason?: unknown): void;
}
