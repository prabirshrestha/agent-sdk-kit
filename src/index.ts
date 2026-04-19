// Types
export type {
  Agent,
  AgentEvent,
  AgentStreamResult,
  AgentUsage,
  AgentInfo,
  AgentTool,
  ToolContext,
  SessionResult,
  CallOptions,
  ForkOptions,
  ProviderName,
  TransportKind,
  Attachment,
  ContentPart,
  PermissionRequest,
  PermissionDecision,
  CreateAgentOptions,
  SandboxConfig,
  SandboxPolicy,
  McpServerConfig,
  ClaudeConfig,
  CopilotConfig,
  OpencodeConfig,
  PiConfig,
  AcpConfig,
  Provider,
  StreamOp,
  AgentStream,
  ProviderImpl,
  EventBase,
} from "./types.js";

// Factories
export { createAgent } from "./agent.js";
export { claude } from "./providers/claude.js";
export { copilot } from "./providers/copilot.js";
export { opencode } from "./providers/opencode.js";
export { pi } from "./providers/pi.js";
export { acp } from "./providers/acp.js";

// Detection
export { detectAgents, isProviderAvailable, probeProvider } from "./detect.js";

// Errors
export { AgentError, redactSecrets } from "./errors.js";
export type { AgentErrorKind } from "./errors.js";

// Events helpers
export {
  sessionEvent,
  turnStartEvent,
  turnEndEvent,
  textDeltaEvent,
  thinkingDeltaEvent,
  assistantMessageEvent,
  toolCallEvent,
  toolResultEvent,
  toolProgressEvent,
  resultEvent,
  errorEvent,
  rawEvent,
  modelInfoEvent,
  usageEvent,
  commandExecEvent,
  fileChangeEvent,
  webSearchEvent,
  todoUpdateEvent,
  userMessageEvent,
  sessionForkedEvent,
  availableCommandsEvent,
  permissionRequestEvent,
} from "./events.js";

/** @internal */
export { withMeta, extensionEvent } from "./events.js";

// Stream result factory
export { createStreamResult } from "./stream.js";

// Spawn utilities
export { parseJsonlStream } from "./spawn.js";
/** @internal */
export { spawnJsonl } from "./spawn.js";
export type { SpawnOptions, SpawnResult } from "./spawn.js";

// Custom tools
export { tool, fromZod } from "./tools.js";
export type { ToolDefinition } from "./tools.js";

// Attachments
export { materializeAttachments, cleanupAttachments } from "./attachments.js";
export type { MaterializedAttachment } from "./attachments.js";

// MCP servers
export { compileMcp } from "./mcp.js";
export type { CompiledMcp } from "./mcp.js";

// Sandbox
export { applySandbox } from "./sandbox/index.js";
export type { SandboxApplyResult } from "./sandbox/index.js";

// copilot-api daemon helper
export { ensureCopilotApi } from "./copilot-api.js";
export type { CopilotApiDaemonConfig, CopilotApiHandle } from "./copilot-api.js";

// ACP transport
/** @internal */
export { createAcpTransport } from "./transports/acp.js";

// SDK transports
export { createCopilotSdkTransport } from "./transports/sdk-copilot.js";
export { createOpencodeSdkTransport } from "./transports/sdk-opencode.js";
