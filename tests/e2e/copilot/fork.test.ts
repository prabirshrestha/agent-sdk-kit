// copilot SDK: forkSession (new sessionId, parent context inherited).
import { describe, test, expect } from "bun:test";
import { createAgent, copilot } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("copilot-sdk");

describe.skipIf(!enabled)("copilot SDK / fork", () => {
  test("fork creates a new sessionId and inherits parent context", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    const r1 = await agent.run({ prompt: "remember the word: banana" }).result;
    const r2 = await agent.run({
      prompt: "what word did I ask you to remember? reply with just the word",
      options: { resume: r1.sessionId, forkSession: true },
    }).result;

    expect(r2.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("banana");
  }, 240_000);
});
