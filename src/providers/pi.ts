/**
 * Pi provider — CLI transport for the `pi` coding assistant.
 *
 * Verified against pi CLI 0.67.68. Event taxonomy observed from `pi -p "..." --mode json`:
 *
 *   {"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"...","parentSession":"<path>"?}
 *   {"type":"agent_start"}
 *   {"type":"turn_start"}
 *   {"type":"message_start","message":{role:"user"|"assistant", content:[...], ...}}
 *   {"type":"message_update","assistantMessageEvent":{type:"text_start"|"text_delta"|"text_end", delta?,content?, ...}}
 *   {"type":"message_end","message":{...}}
 *   {"type":"turn_end","message":{role:"assistant", content:[{type:"text", text:"..."}], usage:{...}, stopReason:"..."}, toolResults:[...]}
 *   {"type":"agent_end","messages":[...]}
 *
 * Session ID is the UUID emitted in the `session` event (pi identifies sessions by
 * UUID within a project-slugified directory under ~/.pi/agent/sessions/).
 * `--session <uuid>` resolves within the current cwd's project directory.
 */
import * as path from "node:path";
import type { PiConfig, ProviderImpl, StreamOp, CallOptions, AgentEvent } from "../types.js";
import { spawnJsonl } from "../spawn.js";
import {
  sessionEvent,
  turnStartEvent,
  turnEndEvent,
  textDeltaEvent,
  resultEvent,
  errorEvent,
  rawEvent,
} from "../events.js";
import { AgentError, notSupported, redactSecrets } from "../errors.js";
import {
  materializeAttachments,
  cleanupAttachments,
  type MaterializedAttachment,
} from "../attachments.js";
import { applySandbox } from "../sandbox/index.js";

/**
 * Create a Pi provider (CLI transport).
 */
export function pi(config?: PiConfig): ProviderImpl {
  const cwd = config?.cwd ?? process.cwd();
  const binPath = config?.binPath ?? "pi";

  let transport = config?.transport ?? "cli";
  if (transport === "rpc") {
    console.warn(`[agent-sdk] pi: transport "rpc" is not yet supported, falling back to "cli"`);
    transport = "cli";
  }

  // Per-provider-instance warn-once flags (see concurrency audit: module-level
  // state would cause concurrent instances to silence each other's warnings).
  let warnedTools = false;
  let warnedMcp = false;

  return {
    name: "pi",
    transport,

    stream(op: StreamOp, opts: CallOptions): AsyncIterable<AgentEvent> {
      return _streamPi(op, opts, {
        cwd,
        binPath,
        config,
        hasWarnedTools: () => warnedTools,
        markWarnedTools: () => {
          warnedTools = true;
        },
        hasWarnedMcp: () => warnedMcp,
        markWarnedMcp: () => {
          warnedMcp = true;
        },
      });
    },

    async deleteSession(_sessionId: string): Promise<void> {
      throw notSupported("Pi provider does not support session deletion", "delete_unsupported");
    },

    async dispose() {
      // No persistent resources for CLI transport
    },
  };
}

export function buildCommand(
  op: StreamOp,
  opts: CallOptions,
  ctx: { cwd: string; binPath: string; config?: PiConfig },
  mats: MaterializedAttachment[] = [],
): string[] {
  const cmd: string[] = [ctx.binPath];

  // Non-interactive / print mode
  cmd.push("-p");

  // JSONL streaming output
  const mode = opts.providerOptions?.pi?.mode ?? "json";
  cmd.push("--mode", mode);

  // Session handling per op kind
  switch (op.kind) {
    case "start": {
      if (op.pinnedSessionId) {
        throw new AgentError(
          "not_supported",
          "pi CLI does not support options.sessionId (pinning a UUID for a new session).",
        );
      }
      break;
    }
    case "resume": {
      if (!op.sessionId) {
        throw new AgentError("invalid_input", "resume requires a sessionId");
      }
      if (op.atMessageId) {
        throw new AgentError(
          "not_supported",
          "pi CLI does not support resumeSessionAt (resuming at a specific message UUID).",
        );
      }
      // pi resolves a UUID to ~/.pi/agent/sessions/<slug(cwd)>/<ts>_<uuid>.jsonl
      // when run in the same cwd. Absolute paths are also accepted.
      cmd.push("--session", op.sessionId);
      break;
    }
    case "fork": {
      if (!op.sourceSessionId) {
        throw new AgentError("invalid_input", "fork requires a sourceSessionId");
      }
      if (op.atMessageId) {
        throw new AgentError(
          "not_supported",
          "pi CLI does not support forking at a specific message UUID.",
        );
      }
      cmd.push("--fork", op.sourceSessionId);
      break;
    }
    default:
      throw new AgentError("invalid_input", `Unknown op kind: ${(op as StreamOp).kind}`);
  }

  // System prompt overrides / appends — only applies to NEW sessions (start / fork).
  // Resume already has a system prompt baked into the existing session;,
  // passing it again would be incorrect.
  if (op.kind === "start" || op.kind === "fork") {
    if (opts.systemPrompt) {
      cmd.push("--system-prompt", opts.systemPrompt);
    }
    if (opts.appendSystemPrompt) {
      cmd.push("--append-system-prompt", opts.appendSystemPrompt);
    }
  }

  // Model override — per-call `opts.model` wins over construction-time
  // `config.model`. pi supports "provider/id" embedded in --model, so prefer
  // a combined string if config.provider + model both set.
  const modelOverride = opts.model ?? ctx.config?.model;
  if (modelOverride) {
    cmd.push("--model", modelOverride);
  }
  if (ctx.config?.provider) {
    cmd.push("--provider", ctx.config.provider);
  }

  // Extensions
  if (ctx.config?.extensions) {
    for (const ext of ctx.config.extensions) {
      cmd.push("-e", ext);
    }
  }

  // Build prompt with attachment refs appended as @<abs> tokens.
  // pi positional syntax: pi [options] [@files...] [messages...]
  // With -p, we pass prompt and attachment refs as trailing positional args.
  if (mats.length > 0) {
    for (const mat of mats) {
      const absPath = path.isAbsolute(mat.path) ? mat.path : path.resolve(ctx.cwd, mat.path);
      cmd.push(`@${absPath}`);
    }
  }
  cmd.push(op.prompt);

  return cmd;
}

/**
 * Extract session ID from a pi `session` event.
 * Pi uses `id` (UUID) as the session identifier.
 */
function extractSessionId(event: Record<string, unknown>): string | undefined {
  if (event.type === "session") {
    return (event.id as string | undefined) ?? (event.sessionId as string | undefined);
  }
  // Fallback for other events that may carry a session ref
  return (
    (event.sessionId as string | undefined) ?? (event.session_id as string | undefined) ?? undefined
  );
}

/**
 * Extract a usage snapshot from a pi message payload (message.usage).
 */
function usageFromMessage(msg: Record<string, unknown> | undefined):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
      totalTokens?: number;
    }
  | undefined {
  const usage = msg?.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  const cost = usage.cost as Record<string, unknown> | undefined;
  return {
    inputTokens: typeof usage.input === "number" ? usage.input : undefined,
    outputTokens: typeof usage.output === "number" ? usage.output : undefined,
    cacheReadTokens: typeof usage.cacheRead === "number" ? usage.cacheRead : undefined,
    cacheWriteTokens: typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined,
    totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : undefined,
    costUsd: typeof cost?.total === "number" ? (cost.total as number) : undefined,
  };
}

export async function* _streamPi(
  op: StreamOp,
  opts: CallOptions,
  ctx: {
    cwd: string;
    binPath: string;
    config?: PiConfig;
    hasWarnedTools?: () => boolean;
    markWarnedTools?: () => void;
    hasWarnedMcp?: () => boolean;
    markWarnedMcp?: () => void;
  },
): AsyncIterable<AgentEvent> {
  // Pi CLI does not expose client-side tool registration.
  if (opts.tools && Object.keys(opts.tools).length > 0 && !ctx.hasWarnedTools?.()) {
    ctx.markWarnedTools?.();
    console.warn(
      "[agent-sdk/pi] opts.tools ignored on CLI transport — only the copilot SDK transport supports client-side tool registration today.",
    );
  }

  // Pi provider has no MCP config surface (PiConfig omits mcpServers and the
  // pi CLI has no flag). Warn once when callers try to pass per-call servers.
  if (opts.mcpServers && opts.mcpServers.length > 0 && !ctx.hasWarnedMcp?.()) {
    ctx.markWarnedMcp?.();
    console.warn(
      "[agent-sdk/pi] opts.mcpServers ignored — the pi CLI provider does not support MCP server configuration.",
    );
  }

  if (op.kind === "fork") {
    const piOpts = opts.providerOptions?.pi;
    const forkOptIn = Boolean(piOpts?.experimentalFork || piOpts?.fork);
    if (!forkOptIn) {
      throw notSupported(
        "Pi fork is unverified; not enabled by default. Set providerOptions.pi.experimentalFork (or providerOptions.pi.fork) to opt in.",
        "fork_unsupported",
      );
    }
  }

  // Materialize attachments to temp files and append @<abs> refs
  const mats: MaterializedAttachment[] = await materializeAttachments(
    opts.attachments ?? [],
    opts.abortSignal,
  );

  let cmd = buildCommand(op, opts, ctx, mats);

  // Apply sandbox if configured
  let sandboxCleanup: (() => Promise<void>) | undefined;
  const sandboxResult = await applySandbox(cmd, ctx.cwd, ctx.config?.sandbox);
  cmd = sandboxResult.cmd;
  if (sandboxResult.cleanup) {
    sandboxCleanup = sandboxResult.cleanup;
  }

  const {
    lines,
    stderr,
    process: proc,
  } = await spawnJsonl({
    cmd,
    cwd: ctx.cwd,
    abortSignal: opts.abortSignal,
  });

  try {
    let sessionId: string | undefined;
    let sessionEmitted = false;
    let forkEmitted = false;
    let turnStarted = false;
    let turnEnded = false;
    let accumulatedText = "";
    let finalText: string | undefined;
    let lastStopReason: string | undefined;
    let lastMessageId: string | undefined;
    let lastRaw: unknown = undefined;
    let errored = false;
    let eventCount = 0;

    // Watchdog cap: if after this many upstream events we've still not seen a
    // `session` event, synthesize session + turn_start so consumers waiting on
    // `result.sessionId` / a turn boundary don't stall.
    const WATCHDOG_EVENTS = 3;

    // Synthesize session + (optionally) turn_start when upstream skips either.
    // Called from the watchdog path and from the pre-turn-signal implicit path.
    // Uses the resume sessionId when available; otherwise mints a synthetic
    // UUID tagged so callers can identify it as wrapper-synthesized.
    const ensureSessionEmitted = (): string => {
      if (!sessionId) {
        sessionId =
          op.kind === "resume"
            ? op.sessionId
            : `pi-synth-${
                typeof crypto !== "undefined" && "randomUUID" in crypto
                  ? crypto.randomUUID()
                  : Date.now().toString(36)
              }`;
      }
      if (!sessionEmitted) {
        if (op.kind === "fork" && !forkEmitted) {
          forkEmitted = true;
        }
        sessionEmitted = true;
      }
      return sessionId;
    };

    for await (const raw of lines) {
      const event = raw as Record<string, unknown>;
      lastRaw = raw;
      eventCount++;

      // Always emit raw events for debugging / extension consumers
      yield rawEvent("pi", raw);

      const type = event.type as string | undefined;

      // Capture session ID from the first `session` event (or any event that
      // carries an id-like field — extractSessionId falls back to sessionId /
      // session_id on the event itself).
      if (!sessionId) {
        const sid = extractSessionId(event);
        if (sid) sessionId = sid;
      }

      // Primary path: emit session as soon as we see an id from upstream.
      if (sessionId && !sessionEmitted) {
        if (op.kind === "fork" && !forkEmitted) {
          yield {
            type: "session_forked",
            sessionId,
            sourceSessionId: op.sourceSessionId,
          };
          forkEmitted = true;
        } else {
          yield sessionEvent(sessionId);
        }
        sessionEmitted = true;
      }

      // Synthesis watchdog: if we've consumed >= WATCHDOG_EVENTS events and
      // upstream still hasn't produced a session, or we hit an event that
      // implies the turn has begun (first message_start / message_update), we
      // emit session + turn_start ourselves so consumers don't stall.
      const turnImpliedBy = type === "message_start" || type === "message_update";
      if (!sessionEmitted && (turnImpliedBy || eventCount >= WATCHDOG_EVENTS)) {
        const sid = ensureSessionEmitted();
        if (op.kind === "fork" && !forkEmitted) {
          yield {
            type: "session_forked",
            sessionId: sid,
            sourceSessionId: op.sourceSessionId,
          };
          forkEmitted = true;
        } else {
          yield sessionEvent(sid);
        }
      }
      if (!turnStarted && turnImpliedBy) {
        yield turnStartEvent();
        turnStarted = true;
      }

      if (!type) continue;

      switch (type) {
        case "session":
        case "agent_start": {
          // No direct AgentEvent; session already emitted above.
          break;
        }

        case "turn_start": {
          if (!turnStarted) {
            yield turnStartEvent();
            turnStarted = true;
          }
          break;
        }

        case "message_start": {
          // user message_start → we could emit user_message, but the prompt is
          // provided by the caller so it's redundant. Skip.
          break;
        }

        case "message_update": {
          const asm = event.assistantMessageEvent as Record<string, unknown> | undefined;
          if (!asm) break;
          const asmType = asm.type as string | undefined;
          if (asmType === "text_delta") {
            const delta = (asm.delta as string | undefined) ?? "";
            if (delta) {
              accumulatedText += delta;
              const msgId =
                ((asm.partial as Record<string, unknown> | undefined)?.responseId as
                  | string
                  | undefined) ?? lastMessageId;
              if (msgId) lastMessageId = msgId;
              yield textDeltaEvent(delta, msgId);
            }
          } else if (asmType === "text_end") {
            // Full text available as asm.content; the accumulated deltas
            // already cover this. No-op.
            const content = asm.content as string | undefined;
            if (content && accumulatedText.length === 0) {
              // If upstream never emitted deltas (edge case), backfill.
              accumulatedText = content;
              yield textDeltaEvent(content, lastMessageId);
            }
          }
          // text_start and other sub-events: ignored; raw event already yielded.
          break;
        }

        case "message_end": {
          // Assistant message finalized. Capture final text + usage.
          const msg = event.message as Record<string, unknown> | undefined;
          if (msg?.role === "assistant") {
            const contents = Array.isArray(msg.content)
              ? (msg.content as Array<Record<string, unknown>>)
              : [];
            const textPart = contents.find((c) => c.type === "text");
            if (textPart && typeof textPart.text === "string") {
              finalText = textPart.text;
            }
            const responseId = msg.responseId as string | undefined;
            if (responseId) lastMessageId = responseId;
          }
          break;
        }

        case "turn_end": {
          const msg = event.message as Record<string, unknown> | undefined;
          const stopReason = (msg?.stopReason as string | undefined) ?? "end_turn";
          lastStopReason = stopReason;

          const usage = usageFromMessage(msg);
          if (usage) {
            yield {
              type: "usage",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedReadTokens: usage.cacheReadTokens,
              cachedWriteTokens: usage.cacheWriteTokens,
              totalTokens: usage.totalTokens,
              costUsd: usage.costUsd,
            };
          }

          if (!turnEnded) {
            yield turnEndEvent(stopReason);
            turnEnded = true;
          }
          break;
        }

        case "agent_end": {
          // Terminal event — synthesize final `result`.
          const fallbackSessionId = op.kind === "resume" ? op.sessionId : "";
          const finalSessionId = sessionId ?? fallbackSessionId;
          const text = finalText ?? accumulatedText;
          const stopReason = lastStopReason ?? "end_turn";

          if (!sessionEmitted && finalSessionId) {
            yield sessionEvent(finalSessionId);
            sessionEmitted = true;
          }

          yield {
            type: "result",
            sessionId: finalSessionId,
            text,
            stopReason,
            raw,
          };
          break;
        }

        case "error": {
          const errMsg = (event.message as string) ?? (event.error as string) ?? "Unknown pi error";
          const code = event.code as string | undefined;
          errored = true;
          yield errorEvent(errMsg, code, raw);
          break;
        }

        default: {
          // Unknown event type — already yielded as raw.
          break;
        }
      }
    }

    // Safety net: if pi exited without agent_end (e.g. killed), still emit a
    // result so consumers can resolve their promises.
    if (!errored) {
      const fallbackSessionId = op.kind === "resume" ? op.sessionId : "";
      const finalSessionId = sessionId ?? fallbackSessionId;
      // If we never emitted session (no session event seen), emit now.
      if (!sessionEmitted && finalSessionId) {
        yield sessionEvent(finalSessionId);
        sessionEmitted = true;
      }
      // If no agent_end was seen, synthesize a result.
      // (Check via lastRaw: if last event was already an agent_end we emitted
      // the result already.)
      const lastType =
        lastRaw && typeof lastRaw === "object" && lastRaw !== null
          ? ((lastRaw as Record<string, unknown>).type as string | undefined)
          : undefined;
      if (lastType !== "agent_end") {
        yield resultEvent(finalSessionId, finalText ?? accumulatedText, lastRaw);
      }
    }

    // Surface stderr when the CLI exits non-zero without emitting an error event.
    const exitCode = await proc.exitCode.catch(() => 0);
    if (exitCode !== 0 && !errored) {
      const err = redactSecrets((await stderr.catch(() => "")).trim());
      yield errorEvent(err || `pi exited with code ${exitCode}`, `cli_exit_${exitCode}`, {
        exitCode,
        stderr: err,
      });
    }
  } finally {
    try {
      proc.kill();
    } catch {
      // already dead
    }
    await proc.exitCode.catch(() => {});
    await cleanupAttachments(mats);
    if (sandboxCleanup) {
      await Promise.allSettled([sandboxCleanup()]);
    }
  }
}
