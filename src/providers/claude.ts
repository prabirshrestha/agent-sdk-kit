/**
 * Note: Claude Code CLI does not currently expose a per-tool approval hook in its JSONL stream;
 * tool execution is governed by Claude's own permission settings. The `onPermissionRequest` callback
 * is therefore not invoked for the Claude provider. Callers should configure permissions via Claude's
 * own settings (e.g., --permission-mode flag).
 */
import type {
  ClaudeConfig,
  ProviderImpl,
  StreamOp,
  CallOptions,
  AgentEvent,
  AgentUsage,
} from "../types.js";
import { spawnJsonl } from "../spawn.js";
import {
  sessionEvent,
  turnStartEvent,
  turnEndEvent,
  textDeltaEvent,
  thinkingDeltaEvent,
  errorEvent,
  rawEvent,
  extensionEvent,
  withMeta,
} from "../events.js";
import { materializeAttachments, type MaterializedAttachment } from "../attachments.js";
import { AgentError, assertValidSessionId, redactSecrets, type AgentErrorKind } from "../errors.js";
import { compileMcp } from "../mcp.js";
import { applySandbox } from "../sandbox/index.js";
import { ensureCopilotApi, type CopilotApiHandle } from "../copilot-api.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Encode a cwd into Claude's project directory name.
 *
 * Claude Code stores sessions under `~/.claude/projects/<encoded>/<sid>.jsonl`
 * where the encoding replaces BOTH `/` AND `.` with `-`. Examples:
 *   /home/me/repo           → -home-me-repo
 *   /Users/me/project.v2    → -Users-me-project-v2
 *   /home/me/.config/agent  → -home-me--config-agent
 *
 * Replacing only `/` silently misses dotted paths and dotfile dirs, which
 * causes deleteSession (and any cleanup logic) to no-op against the wrong
 * path and leak session files on disk.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Resolve the on-disk path of a Claude session file for a given cwd. */
export function claudeSessionFilePath(cwd: string, sessionId: string): string {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodeClaudeProjectDir(cwd),
    `${sessionId}.jsonl`,
  );
}

/**
 * Create a Claude provider (CLI transport).
 */
export function claude(config?: ClaudeConfig): ProviderImpl {
  const cwd = config?.cwd ?? process.cwd();
  const binPath = config?.binPath ?? "claude";

  // Cache copilot-api handle per provider instance (init once)
  let copilotApiHandle: CopilotApiHandle | null = null;

  // Per-provider-instance flag so we only warn once per instance about
  // opts.tools being ignored on this CLI transport. Module-level would cause
  // concurrent provider instances to silence each other.
  let warnedTools = false;

  const ctx = {
    cwd,
    binPath,
    config,
    copilotApiHandle: () => copilotApiHandle,
    setCopilotApiHandle: (h: CopilotApiHandle) => {
      copilotApiHandle = h;
    },
    hasWarnedTools: () => warnedTools,
    markWarnedTools: () => {
      warnedTools = true;
    },
  };

  return {
    name: "claude",
    transport: "cli",

    stream(op: StreamOp, opts: CallOptions): AsyncIterable<AgentEvent> {
      return _streamClaude(op, opts, ctx);
    },

    async dispose() {
      // Clean up copilot-api handle if owned
      if (copilotApiHandle?.ownsProcess) {
        await copilotApiHandle.dispose();
      }
    },

    async deleteSession(sessionId: string) {
      // Validate sessionId before using it as a path component to prevent
      // path traversal (e.g. "../../etc/passwd").
      assertValidSessionId(sessionId);

      const sessionPath = claudeSessionFilePath(cwd, sessionId);

      try {
        await fs.unlink(sessionPath);
      } catch (err: any) {
        // If file doesn't exist, no-op
        if (err.code !== "ENOENT") {
          throw err;
        }
      }
    },
  };
}

export function buildCommand(
  op: StreamOp,
  opts: CallOptions,
  ctx: { cwd: string; binPath: string; config?: ClaudeConfig },
  mats: MaterializedAttachment[],
): { cmd: string[]; sessionId: string } {
  const cmd: string[] = [ctx.binPath];

  // Build prompt with attachment refs
  let prompt = op.prompt;
  const dirs = new Set<string>();

  if (mats.length > 0) {
    // Append @<path> refs to prompt
    const attachmentRefs = mats
      .map((mat) => {
        const absPath = path.isAbsolute(mat.path) ? mat.path : path.resolve(ctx.cwd, mat.path);
        dirs.add(path.dirname(absPath));
        return `@${absPath}`;
      })
      .join(" ");

    prompt = `${prompt}\n\n${attachmentRefs}`;
  }

  // Prompt (required for non-interactive mode)
  cmd.push("-p", prompt);

  // Add --add-dir for each unique parent directory
  for (const dir of dirs) {
    cmd.push("--add-dir", dir);
  }

  // Streaming JSONL output
  cmd.push("--output-format", "stream-json");
  cmd.push("--verbose");

  // Skip permission prompts for non-interactive use
  cmd.push("--dangerously-skip-permissions");

  let sessionId: string;

  switch (op.kind) {
    case "start": {
      // Pre-generate a session ID (or honor pinned uuid from RunOptions.sessionId)
      // so we know it immediately.
      sessionId = op.pinnedSessionId ?? crypto.randomUUID();
      cmd.push("--session-id", sessionId);
      break;
    }
    case "fork": {
      if (op.atMessageId) {
        throw new AgentError(
          "not_supported",
          "claude CLI does not support resumeSessionAt with forkSession (no message-level branching). Pass options.resume + forkSession only.",
        );
      }
      // Pre-generate a session ID for the forked session
      sessionId = crypto.randomUUID();
      cmd.push("--session-id", sessionId);
      break;
    }
    case "resume": {
      if (!op.sessionId) {
        throw new AgentError("invalid_input", "resume requires a sessionId");
      }
      if (op.atMessageId) {
        throw new AgentError(
          "not_supported",
          "claude CLI does not support resumeSessionAt (resuming at a specific message UUID).",
        );
      }
      sessionId = op.sessionId;
      cmd.push("--resume", sessionId);
      break;
    }
    default:
      throw new AgentError("internal", `Unknown op kind: ${(op as StreamOp).kind}`);
  }

  // Model override — per-call `opts.model` wins over construction-time
  // `config.model` so callers can switch models per turn.
  const modelOverride = opts.model ?? ctx.config?.model;
  if (modelOverride) {
    cmd.push("--model", modelOverride);
  }

  // System prompt — only applies to NEW sessions (start / fork).
  // Resume already has a system prompt baked into the existing session;,
  // passing it again would be incorrect.
  if (op.kind === "start" || op.kind === "fork") {
    if (opts.systemPrompt) {
      cmd.push("--append-system-prompt", opts.systemPrompt);
    } else if (opts.appendSystemPrompt) {
      cmd.push("--append-system-prompt", opts.appendSystemPrompt);
    }
  }

  // Max budget
  const maxBudget = opts.providerOptions?.claude?.maxBudgetUsd;
  if (maxBudget !== undefined) {
    cmd.push("--max-budget-usd", String(maxBudget));
  }

  return { cmd, sessionId };
}

function parseUsage(raw: Record<string, unknown>): AgentUsage | undefined {
  const usage = raw.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;

  return {
    inputTokens: (usage.input_tokens as number) ?? 0,
    outputTokens: (usage.output_tokens as number) ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens as number | undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens as number | undefined,
    costUsd: raw.total_cost_usd as number | undefined,
  };
}

async function* _streamClaude(
  op: StreamOp,
  opts: CallOptions,
  ctx: {
    cwd: string;
    binPath: string;
    config?: ClaudeConfig;
    copilotApiHandle: () => CopilotApiHandle | null;
    setCopilotApiHandle: (h: CopilotApiHandle) => void;
    hasWarnedTools?: () => boolean;
    markWarnedTools?: () => void;
  },
): AsyncIterable<AgentEvent> {
  // Warn once per provider instance when opts.tools is passed: the Claude CLI
  // has `--tools` but that only filters built-in tools; it does not accept
  // client-side tool handlers. For custom tool registration callers should
  // use the Copilot SDK transport.
  if (opts.tools && Object.keys(opts.tools).length > 0 && !ctx.hasWarnedTools?.()) {
    ctx.markWarnedTools?.();
    console.warn(
      "[agent-sdk/claude] opts.tools ignored on CLI transport — only the copilot SDK transport supports client-side tool registration today.",
    );
  }

  let mats: MaterializedAttachment[] = [];
  let mcpCleanup: (() => Promise<void>) | undefined;
  let sandboxCleanup: (() => Promise<void>) | undefined;

  try {
    // 1. Handle copilot-api if via === "copilot-api"
    let env: Record<string, string> | undefined;
    if (ctx.config?.via === "copilot-api") {
      // Get or create copilot-api handle
      let handle = ctx.copilotApiHandle();
      if (!handle) {
        handle = await ensureCopilotApi(ctx.config.copilotApi ?? {});
        ctx.setCopilotApiHandle(handle);
      }

      // Build env vars for claude
      env = {
        ANTHROPIC_BASE_URL: handle.baseUrl,
        ANTHROPIC_AUTH_TOKEN: handle.authToken,
      };

      // Add model if specified
      if (ctx.config.copilotApi?.model || ctx.config.model) {
        env.ANTHROPIC_MODEL = ctx.config.copilotApi?.model || ctx.config.model || "";
      }
    }

    // 2. Materialize attachments
    mats = await materializeAttachments(opts.attachments ?? [], opts.abortSignal);

    // 3. Build command with attachments
    let { cmd, sessionId } = buildCommand(op, opts, ctx, mats);

    // 4. Add MCP config if present. Merge config-level + per-call mcpServers
    //    so callers can augment the provider-level list on individual turns.
    const mergedMcp = [...(ctx.config?.mcpServers ?? []), ...(opts.mcpServers ?? [])];
    if (mergedMcp.length) {
      const compiled = await compileMcp(mergedMcp, "claude");
      if (compiled.claude) {
        cmd.push("--mcp-config", compiled.claude.configPath);
        mcpCleanup = compiled.claude.cleanup;
      }
    }

    // 5. Apply sandbox if configured
    const sandboxConfig = ctx.config?.sandbox;
    if (sandboxConfig) {
      const sandboxResult = await applySandbox(cmd, ctx.cwd, sandboxConfig);
      cmd = sandboxResult.cmd;
      sandboxCleanup = sandboxResult.cleanup;
    }

    // Spawn the CLI process
    const {
      lines,
      stderr,
      process: proc,
    } = await spawnJsonl({
      cmd,
      cwd: ctx.cwd,
      env,
      abortSignal: opts.abortSignal,
    });

    // For fork ops, emit a session_forked event upfront
    if (op.kind === "fork" && op.sourceSessionId) {
      yield { type: "session_forked", sessionId, sourceSessionId: op.sourceSessionId };
    }

    let emittedSession = false;
    let errorEmitted = false;

    for await (const line of lines) {
      const event = line as Record<string, unknown>;
      const type = event.type as string | undefined;
      const subtype = event.subtype as string | undefined;

      if (!type) {
        yield rawEvent("claude", event);
        continue;
      }

      // --- system.init ---
      if (type === "system" && subtype === "init") {
        const sid = (event.session_id as string) || sessionId;
        yield sessionEvent(sid);
        emittedSession = true;

        // Emit model_info if present
        if (event.model) {
          yield { type: "model_info", currentModel: event.model as string };
        }

        yield turnStartEvent();
        continue;
      }

      // --- system.task_started (subagent lifecycle) ---
      if (type === "system" && subtype === "task_started") {
        const taskId = event.task_id as string;
        const toolUseId = event.tool_use_id as string;
        const taskType = event.task_type as string;

        yield {
          type: "extension",
          namespace: "agent-sdk.subagent",
          kind: "start",
          data: {
            subagentId: taskId,
            parentToolCallId: toolUseId,
            agentName: taskType,
          },
        };
        continue;
      }

      // --- system.task_finished (subagent lifecycle) ---
      if (type === "system" && subtype === "task_finished") {
        const taskId = event.task_id as string;

        yield {
          type: "extension",
          namespace: "agent-sdk.subagent",
          kind: "end",
          data: {
            subagentId: taskId,
          },
        };
        continue;
      }

      // --- system.turn_duration (turn performance metrics) ---
      if (type === "system" && subtype === "turn_duration") {
        yield extensionEvent("claude.system.turn_duration", "turn_duration", {
          durationMs: event.durationMs,
          messageCount: event.messageCount,
        });
        continue;
      }

      // --- system.away_summary (session recap on pause) ---
      if (type === "system" && subtype === "away_summary") {
        yield extensionEvent("claude.system.away_summary", "away_summary", {
          summary: event.content,
        });
        continue;
      }

      // --- system.stop_hook_summary (lifecycle hooks executed) ---
      if (type === "system" && subtype === "stop_hook_summary") {
        yield extensionEvent("claude.system.stop_hook_summary", "stop_hook_summary", {
          hookCount: event.hookCount,
          hookInfos: event.hookInfos,
          hookErrors: event.hookErrors,
          preventedContinuation: event.preventedContinuation,
        });
        continue;
      }

      // --- system.local_command (local hook command output) ---
      if (type === "system" && subtype === "local_command") {
        yield extensionEvent("claude.system.local_command", "local_command_output", {
          content: event.content,
          level: event.level,
        });
        continue;
      }

      // --- system.api_error (API retry state) ---
      if (type === "system" && subtype === "api_error") {
        yield extensionEvent("claude.system.api_error", "retry", {
          retryAttempt: event.retryAttempt,
          maxRetries: event.maxRetries,
          retryInMs: event.retryInMs,
          error: event.error,
        });
        continue;
      }

      // --- user message ---
      // Claude's stream-json reports tool results back to the model as a
      // synthetic `user` message whose content is a list of `tool_result`
      // parts (each referencing the prior `tool_use` by id). Without this
      // branch those results fall through to `rawEvent` and downstream
      // consumers never see the matching `tool_result` events.
      if (type === "user") {
        const message = event.message as Record<string, unknown> | undefined;
        if (!message) {
          yield rawEvent("claude", event);
          continue;
        }

        const parentToolUseId = message.parent_tool_use_id as string | undefined;
        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(content)) {
          yield rawEvent("claude", event);
          continue;
        }

        for (const part of content) {
          const partType = part.type as string;
          if (partType === "tool_result") {
            const ev: AgentEvent = {
              type: "tool_result",
              callId: (part.tool_use_id as string) ?? "",
              output: part.content ?? "",
              isError: (part.is_error as boolean) ?? false,
              status: (part.is_error ? "failed" : "completed") as "completed" | "failed",
            };
            yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
          } else if (partType === "text") {
            // Rare — a user-authored text injected by the CLI (e.g. a
            // permission denial reason). Surface as a delta so audit
            // logs capture it.
            const text = part.text as string;
            if (text) {
              const ev = textDeltaEvent(text);
              yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
            }
          } else {
            const ev = rawEvent("claude", event);
            yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
          }
        }
        continue;
      }

      // --- assistant message ---
      if (type === "assistant") {
        const message = event.message as Record<string, unknown> | undefined;
        if (!message) {
          yield rawEvent("claude", event);
          continue;
        }

        // Check for parent_tool_use_id (subagent events)
        const parentToolUseId = message.parent_tool_use_id as string | undefined;

        const content = message.content as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(content)) {
          yield rawEvent("claude", event);
          continue;
        }

        for (const part of content) {
          const partType = part.type as string;

          if (partType === "text") {
            const text = part.text as string;
            if (text) {
              const ev = textDeltaEvent(text);
              yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
            }
          } else if (partType === "thinking") {
            const thinkingText = part.thinking as string;
            if (thinkingText) {
              const ev = thinkingDeltaEvent(thinkingText);
              yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
            }
          } else if (partType === "tool_use") {
            const ev: AgentEvent = {
              type: "tool_call",
              callId: (part.id as string) ?? "",
              name: (part.name as string) ?? "",
              input: part.input ?? {},
              status: "in_progress" as const,
            };
            yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
          } else if (partType === "tool_result") {
            const ev: AgentEvent = {
              type: "tool_result",
              callId: (part.tool_use_id as string) ?? "",
              output: part.content ?? "",
              isError: (part.is_error as boolean) ?? false,
              status: (part.is_error ? "failed" : "completed") as "completed" | "failed",
            };
            yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
          } else {
            const ev = rawEvent("claude", event);
            yield parentToolUseId ? withMeta(ev, { subagentId: parentToolUseId }) : ev;
          }
        }
        continue;
      }

      // --- result ---
      if (type === "result") {
        if (subtype === "success") {
          const sid = (event.session_id as string) || sessionId;
          const text = (event.result as string) ?? "";
          const usage = parseUsage(event);
          const stopReason = (event.stop_reason as string) ?? "end_turn";

          yield turnEndEvent(stopReason);
          yield {
            type: "result",
            sessionId: sid,
            text,
            stopReason,
            usage,
            raw: event,
          };
        } else if (subtype === "error") {
          const errMsg =
            (event.error as string) ?? (event.result as string) ?? "Unknown claude error";
          const { kind, code } = mapClaudeError(errMsg);
          errorEmitted = true;
          yield errorEvent(errMsg, code, { kind, event });
        } else {
          yield rawEvent("claude", event);
        }
        continue;
      }

      // --- attachment (deferred tools delta) ---
      if (type === "attachment") {
        const att = event.attachment as Record<string, unknown> | undefined;
        yield extensionEvent("claude.attachment", (att?.type as string) || "attachment", att || {});
        continue;
      }

      // --- ai-title (session title generated) ---
      if (type === "ai-title") {
        yield extensionEvent("claude.ai-title", "title_generated", {
          title: event.aiTitle,
        });
        continue;
      }

      // --- permission-mode (permission bypass mode changed) ---
      if (type === "permission-mode") {
        yield extensionEvent("claude.permission-mode", "permission_mode_changed", {
          mode: event.permissionMode,
        });
        continue;
      }

      // --- file-history-snapshot (file state checkpoint) ---
      if (type === "file-history-snapshot") {
        yield extensionEvent("claude.file-history-snapshot", "snapshot", {
          timestamp: (event.snapshot as Record<string, unknown>)?.timestamp,
          trackedFileBackups: (event.snapshot as Record<string, unknown>)?.trackedFileBackups,
          isUpdate: event.isSnapshotUpdate,
        });
        continue;
      }

      // --- queue-operation (operation queue state) ---
      if (type === "queue-operation") {
        yield extensionEvent("claude.queue-operation", "operation", {
          operation: event.operation,
          content: event.content,
          timestamp: event.timestamp,
        });
        continue;
      }

      // --- last-prompt (user's prompt echoed back) ---
      if (type === "last-prompt") {
        yield extensionEvent("claude.last-prompt", "last_prompt", {
          prompt: event.lastPrompt,
        });
        continue;
      }

      // --- unknown event ---
      yield rawEvent("claude", event);
    }

    // If we never got a system.init (e.g., process died early), still emit session
    if (!emittedSession) {
      yield sessionEvent(sessionId);
    }

    // Surface stderr when the CLI exits non-zero without emitting an error event.
    const exitCode = await proc.exitCode.catch(() => 0);
    if (exitCode !== 0 && !errorEmitted) {
      const err = redactSecrets((await stderr.catch(() => "")).trim());
      yield errorEvent(err || `claude exited with code ${exitCode}`, `cli_exit_${exitCode}`, {
        exitCode,
        stderr: err,
      });
    }
  } finally {
    // Cleanup runs even on early abort; allSettled prevents one failure
    // from preventing the others.
    await Promise.allSettled(mats.map((m) => m.cleanup?.()));

    if (mcpCleanup) {
      await Promise.allSettled([mcpCleanup()]);
    }

    if (sandboxCleanup) {
      await Promise.allSettled([sandboxCleanup()]);
    }
  }
}

/** Map a raw error message from Claude to a more specific error kind/code. */
function mapClaudeError(message: string): { kind: AgentErrorKind; code: string } {
  if (/auth|unauthorized|api key/i.test(message)) {
    return { kind: "auth", code: "auth_failed" };
  }
  if (/rate.?limit|too many requests|429/i.test(message)) {
    return { kind: "rate_limit", code: "rate_limit" };
  }
  if (/timeout/i.test(message)) {
    return { kind: "timeout", code: "timeout" };
  }
  if (/not.?supported|unsupported/i.test(message)) {
    return { kind: "not_supported", code: "not_supported" };
  }
  return { kind: "provider", code: "provider_error" };
}
