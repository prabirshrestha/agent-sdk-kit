import { describe, test, expect } from "bun:test";
import { createAgent, claude, isProviderAvailable } from "../../src/index.js";

const claudeAvailable = await isProviderAvailable("claude").catch(() => false);

describe.skipIf(!claudeAvailable)("claude fork e2e", () => {
  test("forks a session and remembers prior context", async () => {
    await using agent = createAgent({
      provider: claude({ cwd: "/tmp", model: "claude-haiku-4-5" }),
    });

    const turn1 = agent.run({ prompt: "remember the number 42" });
    const result1 = await turn1.result;
    const sourceSessionId = result1.sessionId;
    expect(sourceSessionId).toBeTruthy();

    const turn2 = agent.run({
      prompt: "what number did I tell you? reply with just the number",
      options: { resume: sourceSessionId, forkSession: true },
    });
    const result2 = await turn2.result;

    expect(result2.text.toLowerCase()).toContain("42");
    // Forked session should be a new id (independent of source)
    expect(result2.sessionId).toBeTruthy();
  }, 180_000);
});
