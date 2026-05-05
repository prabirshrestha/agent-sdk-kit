// claude CLI: forkSession (new sessionId, inherits parent context).
import { describe, test, expect } from "bun:test";
import { createAgent, claude } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("claude");
const provider = () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" });

describe.skipIf(!enabled)("claude / fork", () => {
  test("fork creates a new sessionId and keeps prior context", async () => {
    await using agent = createAgent({ provider: provider() });
    const r1 = await agent.run({ prompt: "remember the number 42" }).result;
    const r2 = await agent.run({
      prompt: "what number did I tell you? reply with just the number",
      options: { resume: r1.sessionId, forkSession: true },
    }).result;

    expect(r2.sessionId).toBeTruthy();
    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("42");
  }, 180_000);
});
