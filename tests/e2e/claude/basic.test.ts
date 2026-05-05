// claude CLI: basic lifecycle (start, stream, ordering, uuid).
//
// Gating: RUN_E2E_CLAUDE=1 (or RUN_E2E=1) AND `claude --version` succeeds.
import { describe, test, expect } from "bun:test";
import { createAgent, claude } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

const enabled = await e2eGate("claude");
const provider = () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" });

describe.skipIf(!enabled)("claude / basic", () => {
  test("start → sessionId is UUID + text contains pong + provider tag", async () => {
    await using agent = createAgent({ provider: provider() });
    const result = await agent.run({ prompt: "reply with exactly: pong" }).result;

    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("claude");
  }, 120_000);

  test("textStream yields chunks that concatenate to the final text", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });
    const chunks: string[] = [];
    for await (const c of turn.textStream) chunks.push(c);
    await turn.result;
    expect(chunks.join("").toLowerCase()).toContain("pong");
  }, 120_000);

  test("fullStream ordering: session → turn_start → text_delta? → turn_end → result", async () => {
    await using agent = createAgent({ provider: provider() });
    const events = await collectFullStream(agent.run({ prompt: "reply with exactly: pong" }));
    assertLifecycleOrdering(events, { label: "claude/basic" });
  }, 120_000);
});
