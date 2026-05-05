// Tests the per-call `opts.model` override on the CLI providers (claude, pi).
// Verifies precedence: opts.model > config.model > omitted.
//
// SDK transports (copilot, opencode) wire `opts.model ?? config?.model` into
// SDK calls that require spawning real subprocesses to exercise — those are
// covered by the e2e suite, not here.

import { describe, test, expect } from "bun:test";
import { buildCommand as buildClaudeCommand } from "../../src/providers/claude.js";
import { buildCommand as buildPiCommand } from "../../src/providers/pi.js";
import type { StreamOp, CallOptions } from "../../src/types.js";

function flagValue(cmd: string[], flag: string): string | undefined {
  const i = cmd.indexOf(flag);
  return i >= 0 ? cmd[i + 1] : undefined;
}

describe("claude per-call model override", () => {
  const op: StreamOp = { kind: "start", prompt: "hi" };
  const ctx = { cwd: "/tmp", binPath: "claude" };

  test("opts.model wins over config.model", () => {
    const opts: CallOptions = { model: "claude-haiku-4-5" };
    const { cmd } = buildClaudeCommand(
      op,
      opts,
      { ...ctx, config: { model: "claude-sonnet-4-5" } },
      [],
    );
    expect(flagValue(cmd, "--model")).toBe("claude-haiku-4-5");
  });

  test("falls back to config.model when opts.model omitted", () => {
    const { cmd } = buildClaudeCommand(
      op,
      {},
      { ...ctx, config: { model: "claude-sonnet-4-5" } },
      [],
    );
    expect(flagValue(cmd, "--model")).toBe("claude-sonnet-4-5");
  });

  test("no --model flag when neither set", () => {
    const { cmd } = buildClaudeCommand(op, {}, ctx, []);
    expect(cmd).not.toContain("--model");
  });

  test("opts.model honored when no config.model", () => {
    const opts: CallOptions = { model: "claude-opus-4-1" };
    const { cmd } = buildClaudeCommand(op, opts, ctx, []);
    expect(flagValue(cmd, "--model")).toBe("claude-opus-4-1");
  });
});

describe("pi per-call model override", () => {
  const op: StreamOp = { kind: "start", prompt: "hi" };
  const ctx = { cwd: "/tmp", binPath: "pi" };

  test("opts.model wins over config.model", () => {
    const opts: CallOptions = { model: "gpt-5" };
    const cmd = buildPiCommand(op, opts, { ...ctx, config: { model: "gpt-4" } }, []);
    expect(flagValue(cmd, "--model")).toBe("gpt-5");
  });

  test("falls back to config.model when opts.model omitted", () => {
    const cmd = buildPiCommand(op, {}, { ...ctx, config: { model: "gpt-4" } }, []);
    expect(flagValue(cmd, "--model")).toBe("gpt-4");
  });

  test("no --model flag when neither set", () => {
    const cmd = buildPiCommand(op, {}, ctx, []);
    expect(cmd).not.toContain("--model");
  });
});
