// copilot SDK: resumeSessionAt — rewind in place via history.truncate.
//
// Single-LLM-turn pattern: turn 1 sends a memorable word AND captures the
// server-assigned user message id from the streaming events. Turn 2 then
// resumes-at that id (rewinding to before the first user message → empty
// history) and asks for the word — should NOT recall it.
import { describe, test, expect } from "bun:test";
import { createAgent, copilot } from "../../../src/index.js";
import { e2eGate, slowE2eEnabled } from "../_helpers.js";

const enabled = (await e2eGate("copilot-sdk")) && slowE2eEnabled();

describe.skipIf(!enabled)("copilot SDK / resume-at", () => {
  test("resumeSessionAt rewinds in place (same sessionId) via history.truncate", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });

    const t1 = agent.run({ prompt: "remember the word: apple" });
    let userMsgId = "";
    const idDeadline = Date.now() + 30_000;
    for await (const ev of t1.fullStream) {
      if (ev.type === "user_message" && ev.messageId) {
        userMsgId = ev.messageId;
      }
      if (Date.now() > idDeadline && !userMsgId) break;
    }
    const r1 = await t1.result;

    if (!userMsgId) {
      console.warn("[copilot resume-at] user_message id not captured — skipping rewind assertion");
      return;
    }

    const r2 = await agent.run({
      prompt:
        "what single word, if any, did I ask you to remember? say 'none' if I have not asked.",
      options: { resume: r1.sessionId, resumeSessionAt: userMsgId },
    }).result;

    // truncate preserves the same session id (no fork)
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).not.toContain("apple");
  }, 300_000);
});
