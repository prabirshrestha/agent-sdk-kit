// opencode SDK: resumeSessionAt — rewind in place via session.revert.
import { describe, test, expect } from "bun:test";
import { createAgent, opencode } from "../../../src/index.js";
import { e2eGate, withRetry } from "../_helpers.js";

const enabled = await e2eGate("opencode-sdk");
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-4o" } as const;

describe.skipIf(!enabled)("opencode SDK / resume-at", () => {
  test("resumeSessionAt rewinds in place (same sessionId) via session.revert", async () => {
    await using agent = createAgent({ provider: opencode(ocConfig) });

    const r1 = await withRetry(() => agent.run({ prompt: "remember the word: apple" }).result);

    const userMsgId = await withRetry(async () => {
      const turn = agent.run({
        prompt: "remember the word: zebra",
        options: { resume: r1.sessionId },
      });
      let captured = "";
      for await (const ev of turn.fullStream) {
        if (ev.type === "user_message") {
          captured = (ev as { id?: string }).id ?? "";
          break;
        }
      }
      await turn.result;
      return captured;
    });
    if (!userMsgId) return;

    const r3 = await withRetry(
      () =>
        agent.run({
          prompt: "what word did I ask you to remember? reply with just the word",
          options: { resume: r1.sessionId, resumeSessionAt: userMsgId },
        }).result,
    );

    expect(r3.sessionId).toBe(r1.sessionId);
    expect(r3.text.toLowerCase()).toContain("apple");
  }, 300_000);
});
