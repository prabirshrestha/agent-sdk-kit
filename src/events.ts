import type { AgentEvent, EventBase, ProviderName } from "./types.js";

/** Merge _meta into an event, preserving existing _meta keys. */
export function withMeta<T extends EventBase>(event: T, meta: Record<string, unknown>): T {
  return { ...event, _meta: { ...event._meta, ...meta } };
}

/** Create a session lifecycle event. */
export function sessionEvent(sessionId: string): AgentEvent {
  return { type: "session", sessionId };
}

/** Create a turn_start event. */
export function turnStartEvent(): AgentEvent {
  return { type: "turn_start" };
}

/** Create a turn_end event. */
export function turnEndEvent(stopReason: string): AgentEvent {
  return { type: "turn_end", stopReason };
}

/** Create a text_delta event. */
export function textDeltaEvent(delta: string, messageId?: string): AgentEvent {
  return { type: "text_delta", delta, messageId };
}

/** Create a thinking_delta event. */
export function thinkingDeltaEvent(delta: string, messageId?: string): AgentEvent {
  return { type: "thinking_delta", delta, messageId };
}

/** Create an assistant_message event. */
export function assistantMessageEvent(text: string, messageId?: string): AgentEvent {
  return { type: "assistant_message", text, messageId };
}

/** Create a tool_call event. */
export function toolCallEvent(
  callId: string,
  name: string,
  input: unknown,
  status?: "pending" | "in_progress",
): AgentEvent {
  return { type: "tool_call", callId, name, input, status };
}

/** Create a tool_result event. */
export function toolResultEvent(
  callId: string,
  output: unknown,
  isError?: boolean,
  status?: "completed" | "failed" | "cancelled",
): AgentEvent {
  return {
    type: "tool_result",
    callId,
    output,
    isError,
    status: status ?? (isError ? "failed" : "completed"),
  };
}

/** Create a tool_progress event (intermediate yield from a generator tool). */
export function toolProgressEvent(callId: string, name: string, update: unknown): AgentEvent {
  return { type: "tool_progress", callId, name, update };
}

/** Create a result event. */
export function resultEvent(sessionId: string, text: string, raw: unknown): AgentEvent {
  return { type: "result", sessionId, text, raw };
}

/** Create an error event. */
export function errorEvent(message: string, code?: string, raw?: unknown): AgentEvent {
  return { type: "error", message, code, raw };
}

/** Create a raw passthrough event. */
export function rawEvent(source: ProviderName, raw: unknown): AgentEvent {
  return { type: "raw", source, raw };
}

/** Create an extension event. */
export function extensionEvent(namespace: string, kind: string, data: unknown): AgentEvent {
  return { type: "extension", namespace, kind, data };
}

/** Create a model_info event. */
export function modelInfoEvent(
  currentModel: string,
  available?: Array<{ id: string; name: string }>,
): AgentEvent {
  return { type: "model_info", currentModel, available };
}

/** Create a usage event. */
export function usageEvent(usage: {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  contextUsed?: number;
  contextSize?: number;
  costUsd?: number;
}): AgentEvent {
  return { type: "usage", ...usage };
}

/** Create a command_exec event. */
export function commandExecEvent(
  callId: string,
  command: string,
  status: "started" | "running" | "completed" | "failed",
  opts?: {
    cwd?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  },
): AgentEvent {
  return {
    type: "command_exec",
    callId,
    command,
    status,
    cwd: opts?.cwd,
    stdout: opts?.stdout,
    stderr: opts?.stderr,
    exitCode: opts?.exitCode,
  };
}

/** Create a file_change event. */
export function fileChangeEvent(
  callId: string,
  path: string,
  operation: "create" | "update" | "delete",
  status: "proposed" | "applied" | "rejected",
  patch?: string,
): AgentEvent {
  return {
    type: "file_change",
    callId,
    path,
    operation,
    status,
    patch,
  };
}

/** Create a web_search event. */
export function webSearchEvent(
  callId: string,
  query: string,
  results?: Array<{ url: string; title?: string; snippet?: string }>,
): AgentEvent {
  return {
    type: "web_search",
    callId,
    query,
    results,
  };
}

/** Create a todo_update event. */
export function todoUpdateEvent(
  items: Array<{ id: string; text: string; status: "pending" | "in_progress" | "done" }>,
): AgentEvent {
  return {
    type: "todo_update",
    items,
  };
}

/** Create a user_message event. */
export function userMessageEvent(text: string, messageId?: string): AgentEvent {
  return { type: "user_message", text, messageId };
}

/** Create a session_forked event. */
export function sessionForkedEvent(sessionId: string, sourceSessionId: string): AgentEvent {
  return { type: "session_forked", sessionId, sourceSessionId };
}

/** Create an available_commands event. */
export function availableCommandsEvent(
  commands: Array<{ name: string; description?: string }>,
): AgentEvent {
  return { type: "available_commands", commands };
}

/** Create a permission_request event. */
export function permissionRequestEvent(
  requestId: string,
  toolName: string,
  details: unknown,
  opts?: {
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      openWorldHint?: boolean;
      justification?: string;
    };
    respond?: (decision: "allow" | "deny", opts?: { persist?: boolean }) => Promise<void>;
  },
): AgentEvent {
  return {
    type: "permission_request",
    requestId,
    toolName,
    details,
    annotations: opts?.annotations,
    respond: opts?.respond,
  };
}
