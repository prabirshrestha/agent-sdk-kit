// pi CLI: resume / multi-turn (2-turn + 3-turn).
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import {
  e2eGate,
  assertLifecycleOrdering,
  collectFullStream,
  slowE2eEnabled,
} from "../_helpers.js";

const enabled = (await e2eGate("pi")) && slowE2eEnabled();
const provider = () => pi({ cwd: process.cwd() });

describe.skipIf(!enabled)("pi / resume", () => {
  test("2-turn resume preserves sessionId + context", async () => {
    await using agent = createAgent({ provider: provider() });
    const r1 = await agent.run({ prompt: "remember the word: banana" }).result;
    const r2 = await agent.run({
      prompt: "what word did I ask you to remember? reply with just the word",
      options: { resume: r1.sessionId },
    }).result;
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("banana");
  }, 180_000);

  test("3-turn resume preserves context + fullStream ordering", async () => {
    await using agent = createAgent({ provider: provider() });
    const r1 = await agent.run({ prompt: "remember the number 42" }).result;
    const e2 = await collectFullStream(
      agent.run({
        prompt: "now also remember the color blue",
        options: { resume: r1.sessionId },
      }),
    );
    assertLifecycleOrdering(e2, { label: "pi/resume t2" });
    const r3 = await agent.run({
      prompt: "what number and color did I tell you? reply: <number> <color>",
      options: { resume: r1.sessionId },
    }).result;

    expect(r3.sessionId).toBe(r1.sessionId);
    expect(r3.text.toLowerCase()).toContain("42");
    expect(r3.text.toLowerCase()).toContain("blue");
  }, 300_000);
});
