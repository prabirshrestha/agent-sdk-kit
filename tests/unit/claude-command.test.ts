import { describe, test, expect } from "bun:test";
import { buildCommand } from "../../src/providers/claude.js";
import type { StreamOp, CallOptions } from "../../src/types.js";

const ctx = { cwd: "/tmp", binPath: "claude" };

describe("buildCommand --append-system-prompt", () => {
  test("start op with systemPrompt includes --append-system-prompt", () => {
    const op: StreamOp = { kind: "start", prompt: "hello" };
    const opts: CallOptions = { systemPrompt: "you are a helpful agent" };
    const { cmd } = buildCommand(op, opts, ctx, []);
    expect(cmd).toContain("--append-system-prompt");
    const idx = cmd.indexOf("--append-system-prompt");
    expect(cmd[idx + 1]).toBe("you are a helpful agent");
  });

  test("resume op with systemPrompt does NOT include --append-system-prompt", () => {
    const op: StreamOp = {
      kind: "resume",
      sessionId: "abc-123",
      prompt: "continue",
    };
    const opts: CallOptions = { systemPrompt: "you are a helpful agent" };
    const { cmd } = buildCommand(op, opts, ctx, []);
    expect(cmd).not.toContain("--append-system-prompt");
  });

  test("fork op with systemPrompt includes --append-system-prompt", () => {
    const op: StreamOp = {
      kind: "fork",
      sourceSessionId: "src-456",
      prompt: "branch off",
    };
    const opts: CallOptions = { systemPrompt: "you are a helpful agent" };
    const { cmd } = buildCommand(op, opts, ctx, []);
    expect(cmd).toContain("--append-system-prompt");
    const idx = cmd.indexOf("--append-system-prompt");
    expect(cmd[idx + 1]).toBe("you are a helpful agent");
  });

  test("resume op with appendSystemPrompt does NOT include --append-system-prompt", () => {
    const op: StreamOp = {
      kind: "resume",
      sessionId: "abc-123",
      prompt: "continue",
    };
    const opts: CallOptions = { appendSystemPrompt: "extra instructions" };
    const { cmd } = buildCommand(op, opts, ctx, []);
    expect(cmd).not.toContain("--append-system-prompt");
  });
});
