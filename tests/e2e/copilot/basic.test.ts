// copilot SDK: basic lifecycle (start, stream, ordering, persistence).
//
// Gating: RUN_E2E_COPILOT_SDK=1 (or RUN_E2E=1) AND @github/copilot-sdk import succeeds.
import { describe, test, expect } from "bun:test";
import { createAgent, copilot } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

const enabled = await e2eGate("copilot-sdk");

describe.skipIf(!enabled)("copilot SDK / basic", () => {
  test("start → sessionId is UUID + text contains pong + provider tag", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    const result = await agent.run({ prompt: "reply with exactly: pong" }).result;

    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("copilot");
  }, 120_000);

  test("textStream concatenates to final text", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    const turn = agent.run({ prompt: "reply with exactly: pong" });
    const chunks: string[] = [];
    for await (const c of turn.textStream) chunks.push(c);
    expect(chunks.join("").toLowerCase()).toContain("pong");
  }, 120_000);

  test("fullStream ordering invariant holds", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    const events = await collectFullStream(agent.run({ prompt: "reply with exactly: pong" }));
    assertLifecycleOrdering(events, { label: "copilot/basic" });
    // SDK transport emits session synchronously at the head of the stream.
    expect(events[0]?.type).toBe("session");
  }, 120_000);

  test("session is persisted to ~/.copilot/session-state/<uuid>", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    const result = await agent.run({ prompt: "reply with exactly: pong" }).result;

    const { existsSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const path = await import("node:path");
    const dir = path.join(homedir(), ".copilot", "session-state", result.sessionId);
    expect(existsSync(dir)).toBe(true);
  }, 120_000);

  test("transport is reported as sdk", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    expect(agent.transport).toBe("sdk");
  });
});
