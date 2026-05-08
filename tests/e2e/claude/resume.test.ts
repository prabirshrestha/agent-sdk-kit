// claude CLI: resume / multi-turn (2-turn + 3-turn).
import { describe, test, expect } from "bun:test";
import { createAgent, claude } from "../../../src/index.js";
import {
  e2eGate,
  assertLifecycleOrdering,
  collectFullStream,
} from "../_helpers.js";

const enabled = await e2eGate("claude");
const provider = () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" });

describe.skipIf(!enabled)("claude / resume", () => {
  test("2-turn resume preserves sessionId and context", async () => {
    await using agent = createAgent({ provider: provider() });
    const r1 = await agent.run({ prompt: "remember the word: banana" }).result;
    const r2 = await agent.run({
      prompt: "what word did I ask you to remember? reply with just the word",
      options: { resume: r1.sessionId },
    }).result;

    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("banana");
  }, 180_000);

  test("3-turn resume preserves context across both turns + fullStream ordering on each", async () => {
    await using agent = createAgent({ provider: provider() });

    const e1 = await collectFullStream(agent.run({ prompt: "remember the number 42" }));
    assertLifecycleOrdering(e1, { label: "claude/resume t1" });
    const r1 = e1.find((e) => e.type === "result") as unknown as { sessionId: string };

    const t2 = agent.run({
      prompt: "now also remember the color blue",
      options: { resume: r1.sessionId },
    });
    const e2 = await collectFullStream(t2);
    assertLifecycleOrdering(e2, { label: "claude/resume t2" });

    const t3 = agent.run({
      prompt: "what number and color did I tell you? reply: <number> <color>",
      options: { resume: r1.sessionId },
    });
    const r3 = await t3.result;

    expect(r3.sessionId).toBe(r1.sessionId);
    expect(r3.text.toLowerCase()).toContain("42");
    expect(r3.text.toLowerCase()).toContain("blue");
  }, 300_000);
});
