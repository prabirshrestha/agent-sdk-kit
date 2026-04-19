import { describe, test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildCommand, _streamPi } from "../../src/providers/pi.js";
import type { StreamOp, CallOptions, AgentEvent } from "../../src/types.js";

const CTX = { cwd: "/tmp", binPath: "pi" };

/**
 * Create a fake executable on disk that prints the given JSONL lines to stdout.
 * Used to drive _streamPi without a real pi binary. Caller is responsible for
 * unlinking the returned path when done.
 */
async function makeFakePiBin(jsonlLines: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fake-"));
  const binPath = path.join(dir, "pi");
  // Use printf to avoid shell escape issues with JSON quotes.
  const script = ["#!/bin/sh"];
  for (const line of jsonlLines) {
    const escaped = line.replace(/'/g, "'\\''");
    script.push(`printf '%s\\n' '${escaped}'`);
  }
  await fs.writeFile(binPath, script.join("\n"), { mode: 0o755 });
  return binPath;
}

describe("pi buildCommand mode", () => {
  test("mode: 'rpc' includes --mode rpc", () => {
    const op: StreamOp = { kind: "start", prompt: "hi" };
    const opts: CallOptions = { providerOptions: { pi: { mode: "rpc" } } };
    const cmd = buildCommand(op, opts, CTX);
    const modeIdx = cmd.indexOf("--mode");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(cmd[modeIdx + 1]).toBe("rpc");
  });

  test("no mode defaults to --mode json", () => {
    const op: StreamOp = { kind: "start", prompt: "hi" };
    const opts: CallOptions = {};
    const cmd = buildCommand(op, opts, CTX);
    const modeIdx = cmd.indexOf("--mode");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(cmd[modeIdx + 1]).toBe("json");
  });

  test("empty providerOptions.pi defaults to --mode json", () => {
    const op: StreamOp = { kind: "start", prompt: "hi" };
    const opts: CallOptions = { providerOptions: { pi: {} } };
    const cmd = buildCommand(op, opts, CTX);
    const modeIdx = cmd.indexOf("--mode");
    expect(cmd[modeIdx + 1]).toBe("json");
  });
});

describe("pi buildCommand systemPrompt gating", () => {
  test("start op includes --system-prompt and --append-system-prompt", () => {
    const op: StreamOp = { kind: "start", prompt: "hi" };
    const opts: CallOptions = {
      systemPrompt: "SYS",
      appendSystemPrompt: "APPEND",
    };
    const cmd = buildCommand(op, opts, CTX);
    expect(cmd).toContain("--system-prompt");
    expect(cmd).toContain("SYS");
    expect(cmd).toContain("--append-system-prompt");
    expect(cmd).toContain("APPEND");
  });

  test("fork op includes --system-prompt and --append-system-prompt", () => {
    const op: StreamOp = { kind: "fork", sourceSessionId: "src", prompt: "hi" };
    const opts: CallOptions = {
      systemPrompt: "SYS",
      appendSystemPrompt: "APPEND",
    };
    const cmd = buildCommand(op, opts, CTX);
    expect(cmd).toContain("--system-prompt");
    expect(cmd).toContain("--append-system-prompt");
  });

  test("resume op does NOT include --system-prompt or --append-system-prompt", () => {
    const op: StreamOp = { kind: "resume", sessionId: "s1", prompt: "hi" };
    const opts: CallOptions = {
      systemPrompt: "SYS",
      appendSystemPrompt: "APPEND",
    };
    const cmd = buildCommand(op, opts, CTX);
    expect(cmd).not.toContain("--system-prompt");
    expect(cmd).not.toContain("--append-system-prompt");
    // Also ensure neither value leaked in as a positional arg
    expect(cmd).not.toContain("SYS");
    expect(cmd).not.toContain("APPEND");
  });
});

describe("pi _streamPi fork gate", () => {
  test("throws on fork without either gate", async () => {
    const op: StreamOp = { kind: "fork", sourceSessionId: "src", prompt: "hi" };
    const opts: CallOptions = {};
    const iter = _streamPi(op, opts, CTX)[Symbol.asyncIterator]();
    let error: unknown;
    try {
      await iter.next();
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect((error as Error).message).toMatch(/Pi fork is unverified/);
    expect((error as Error).message).toMatch(/providerOptions\.pi\.experimentalFork/);
  });

  test("throws on fork with empty pi options", async () => {
    const op: StreamOp = { kind: "fork", sourceSessionId: "src", prompt: "hi" };
    const opts: CallOptions = { providerOptions: { pi: {} } };
    const iter = _streamPi(op, opts, CTX)[Symbol.asyncIterator]();
    let error: unknown;
    try {
      await iter.next();
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect((error as Error).message).toMatch(/Pi fork is unverified/);
  });

  test("accepts fork with experimentalFork: true (passes gate, fails later on spawn)", async () => {
    const op: StreamOp = { kind: "fork", sourceSessionId: "src", prompt: "hi" };
    const opts: CallOptions = {
      providerOptions: { pi: { experimentalFork: true } },
      // Use an aborted signal to short-circuit the spawn path quickly.
      abortSignal: AbortSignal.abort(),
    };
    const iter = _streamPi(
      op,
      { ...opts, abortSignal: undefined },
      {
        ...CTX,
        binPath: "/no/such/pi-bin-12345",
      },
    )[Symbol.asyncIterator]();
    let error: unknown;
    try {
      await iter.next();
    } catch (e) {
      error = e;
    }
    // The gate should NOT fire; any error should not be the fork_unsupported one.
    if (error) {
      expect((error as Error).message).not.toMatch(/Pi fork is unverified/);
    }
  });

  test("accepts fork with fork: true (passes gate, fails later on spawn)", async () => {
    const op: StreamOp = { kind: "fork", sourceSessionId: "src", prompt: "hi" };
    const opts: CallOptions = {
      providerOptions: { pi: { fork: true } },
    };
    const iter = _streamPi(op, opts, {
      ...CTX,
      binPath: "/no/such/pi-bin-12345",
    })[Symbol.asyncIterator]();
    let error: unknown;
    try {
      await iter.next();
    } catch (e) {
      error = e;
    }
    if (error) {
      expect((error as Error).message).not.toMatch(/Pi fork is unverified/);
    }
  });
});

describe("pi _streamPi synthesis watchdog", () => {
  test("synthesizes session + turn_start when upstream emits only message_update", async () => {
    // Only message_update events — no session, agent_start, or turn_start
    // from upstream. Our watchdog should still produce session + turn_start
    // before the first text_delta.
    const binPath = await makeFakePiBin([
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hi" },
      }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "!" },
      }),
    ]);

    try {
      const op: StreamOp = { kind: "start", prompt: "hi" };
      const opts: CallOptions = {};
      const events: AgentEvent[] = [];
      for await (const ev of _streamPi(op, opts, { cwd: "/tmp", binPath })) {
        events.push(ev);
      }

      const types = events.map((e) => e.type);
      expect(types).toContain("session");
      expect(types).toContain("turn_start");

      // The session event must precede the first text_delta so consumers
      // awaiting sessionId resolve before text arrives.
      const sessionIdx = types.indexOf("session");
      const firstTextIdx = types.indexOf("text_delta");
      expect(sessionIdx).toBeGreaterThanOrEqual(0);
      expect(firstTextIdx).toBeGreaterThan(sessionIdx);

      // turn_start must also land before the first text_delta.
      const turnStartIdx = types.indexOf("turn_start");
      expect(turnStartIdx).toBeGreaterThan(sessionIdx);
      expect(turnStartIdx).toBeLessThan(firstTextIdx);

      // Exactly one session and one turn_start — the synthesis path must not
      // double-emit if further events arrive.
      expect(types.filter((t) => t === "session").length).toBe(1);
      expect(types.filter((t) => t === "turn_start").length).toBe(1);
    } finally {
      await fs.rm(path.dirname(binPath), { recursive: true, force: true });
    }
  });

  test("does NOT double-emit session/turn_start when upstream provides them", async () => {
    const binPath = await makeFakePiBin([
      JSON.stringify({ type: "session", id: "upstream-sid-1" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "ok" },
      }),
    ]);

    try {
      const op: StreamOp = { kind: "start", prompt: "hi" };
      const events: AgentEvent[] = [];
      for await (const ev of _streamPi(op, {}, { cwd: "/tmp", binPath })) {
        events.push(ev);
      }
      const types = events.map((e) => e.type);
      // Still exactly one session + one turn_start.
      expect(types.filter((t) => t === "session").length).toBe(1);
      expect(types.filter((t) => t === "turn_start").length).toBe(1);
      // And the sessionId comes from upstream, not synthesis.
      const sessionEv = events.find((e) => e.type === "session");
      expect(sessionEv && (sessionEv as { sessionId: string }).sessionId).toBe("upstream-sid-1");
    } finally {
      await fs.rm(path.dirname(binPath), { recursive: true, force: true });
    }
  });
});
