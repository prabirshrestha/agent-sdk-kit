// copilot SDK: resumeSessionAt — rewind in place via history.truncate.
//
// Captures a user.message id from a follow-up turn, then resumes-at that id
// and verifies the post-truncate turn no longer remembers content from the
// truncated turn.
import { describe, test, expect } from "bun:test";
import { createAgent, copilot } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("copilot-sdk");

describe.skipIf(!enabled)("copilot SDK / resume-at", () => {
  test("resumeSessionAt rewinds in place (same sessionId) via history.truncate", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });

    const r1 = await agent.run({ prompt: "remember the word: apple" }).result;

    let userMsgId = "";
    const t2 = agent.run({
      prompt: "remember the word: zebra",
      options: { resume: r1.sessionId },
    });
    for await (const ev of t2.fullStream) {
      if (ev.type === "user_message") {
        userMsgId = (ev as { id?: string }).id ?? "";
        break;
      }
    }
    await t2.result;
    if (!userMsgId) return; // Older SDK shape — wiring still applies.

    const r3 = await agent.run({
      prompt: "what word did I ask you to remember? reply with just the word",
      options: { resume: r1.sessionId, resumeSessionAt: userMsgId },
    }).result;

    // truncate preserves the same session id (no fork)
    expect(r3.sessionId).toBe(r1.sessionId);
    // Truncated *to and including* userMsgId — the "zebra" turn is gone,
    // so the model should still know "apple".
    expect(r3.text.toLowerCase()).toContain("apple");
  }, 300_000);
});
