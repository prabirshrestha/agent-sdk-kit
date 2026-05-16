// Pi provider: session event emission for fork + watchdog override paths.
//
// Bugs covered (from agent-runner cross-comparison):
//   1. pi-fork-session-event: fork ops emitted only `session_forked` and never
//      the canonical `session` event, breaking consumers that key off `session`.
//   2. pi-watchdog-override: when the watchdog synthesizes a session id and a
//      real `session` event arrives later, the synthetic id was kept and the
//      real id silently ignored.
import { describe, test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _streamPi } from "../../src/providers/pi.js";
import type { StreamOp, CallOptions, AgentEvent } from "../../src/types.js";

async function makeFakePiBin(jsonlLines: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fake-"));
  const binPath = path.join(dir, "pi");
  const script = ["#!/bin/sh"];
  for (const line of jsonlLines) {
    const escaped = line.replace(/'/g, "'\\''");
    script.push(`printf '%s\\n' '${escaped}'`);
  }
  await fs.writeFile(binPath, script.join("\n"), { mode: 0o755 });
  return binPath;
}

async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

describe("pi provider — fork session events", () => {
  test("fork op emits BOTH session_forked AND canonical session event", async () => {
    const binPath = await makeFakePiBin([
      JSON.stringify({ type: "session", id: "fork-sid-1" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
      JSON.stringify({ type: "agent_end" }),
    ]);

    const op: StreamOp = { kind: "fork", sourceSessionId: "src-1", prompt: "hi" };
    const opts: CallOptions = { providerOptions: { pi: { experimentalFork: true } } };
    const events = await collect(_streamPi(op, opts, { cwd: "/tmp", binPath }));

    const forkIdx = events.findIndex((e) => e.type === "session_forked");
    const sessionIdx = events.findIndex((e) => e.type === "session");
    expect(forkIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(-1);
    // session_forked must precede the canonical session event so consumers
    // can distinguish a brand-new id from a resumed/started one.
    expect(forkIdx).toBeLessThan(sessionIdx);
    expect((events[sessionIdx] as { sessionId: string }).sessionId).toBe("fork-sid-1");
    expect((events[forkIdx] as { sourceSessionId: string }).sourceSessionId).toBe("src-1");
  });

  test("fork via watchdog path (no upstream session event) still emits both", async () => {
    const binPath = await makeFakePiBin([
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
      JSON.stringify({ type: "agent_end" }),
    ]);

    const op: StreamOp = { kind: "fork", sourceSessionId: "src-2", prompt: "hi" };
    const opts: CallOptions = { providerOptions: { pi: { experimentalFork: true } } };
    const events = await collect(_streamPi(op, opts, { cwd: "/tmp", binPath }));

    const forkIdx = events.findIndex((e) => e.type === "session_forked");
    const sessionIdx = events.findIndex((e) => e.type === "session");
    expect(forkIdx).toBeGreaterThan(-1);
    expect(sessionIdx).toBeGreaterThan(-1);
    expect(forkIdx).toBeLessThan(sessionIdx);
    // Watchdog-synthesized ids are prefixed `pi-synth-`.
    expect((events[sessionIdx] as { sessionId: string }).sessionId).toMatch(/^pi-synth-/);
  });
});

describe("pi provider — watchdog id override", () => {
  test("real session event arriving after watchdog synth overrides + emits corrective event", async () => {
    // Sequence: 3 non-session events to trigger watchdog (synth id emitted),
    // THEN the real session event arrives → should emit extension correction.
    const binPath = await makeFakePiBin([
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "session", id: "real-sid-9" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
      JSON.stringify({ type: "agent_end" }),
    ]);

    const op: StreamOp = { kind: "start", prompt: "hi" };
    const events = await collect(_streamPi(op, {}, { cwd: "/tmp", binPath }));

    const sessionEvents = events.filter((e) => e.type === "session");
    expect(sessionEvents.length).toBe(1);
    const synthId = (sessionEvents[0] as { sessionId: string }).sessionId;
    expect(synthId).toMatch(/^pi-synth-/);

    const correction = events.find(
      (e) => e.type === "extension" && (e as { kind?: string }).kind === "session_id_corrected",
    ) as { data: { previousSessionId: string; sessionId: string } } | undefined;
    expect(correction).toBeDefined();
    expect(correction!.data.previousSessionId).toBe(synthId);
    expect(correction!.data.sessionId).toBe("real-sid-9");

    // Final result must carry the corrected (real) sessionId.
    const result = events.find((e) => e.type === "result") as { sessionId: string };
    expect(result.sessionId).toBe("real-sid-9");
  });

  test("no correction event when upstream session arrives before watchdog fires", async () => {
    const binPath = await makeFakePiBin([
      JSON.stringify({ type: "session", id: "real-sid-fast" }),
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      }),
      JSON.stringify({ type: "agent_end" }),
    ]);

    const op: StreamOp = { kind: "start", prompt: "hi" };
    const events = await collect(_streamPi(op, {}, { cwd: "/tmp", binPath }));

    const correction = events.find(
      (e) => e.type === "extension" && (e as { kind?: string }).kind === "session_id_corrected",
    );
    expect(correction).toBeUndefined();
    const result = events.find((e) => e.type === "result") as { sessionId: string };
    expect(result.sessionId).toBe("real-sid-fast");
  });
});
