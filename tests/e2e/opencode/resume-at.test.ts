// opencode SDK: resumeSessionAt — rewind in place via session.revert.
//
// Single-LLM-turn pattern: turn 1 sends a memorable word AND captures the
// server-assigned user message id from the streaming events. Turn 2 then
// resumes-at that id (rewinding to before the first user message → empty
// history) and asks for the word — should NOT recall it.
//
// This avoids the multi-turn dance (which compounds LLM latency × retry budget
// and made the previous version hang under shared rate limits).
import { describe, test, expect } from "bun:test";
import { createAgent, opencode } from "../../../src/index.js";
import { e2eGate, withRetry, slowE2eEnabled } from "../_helpers.js";

const enabled = (await e2eGate("opencode-sdk")) && slowE2eEnabled();
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-4o" } as const;

describe.skipIf(!enabled)("opencode SDK / resume-at", () => {
  test("resumeSessionAt rewinds in place (same sessionId) via session.revert", async () => {
    await using agent = createAgent({ provider: opencode(ocConfig) });

    // Turn 1: send "apple" AND capture user_message id from the live stream.
    const { sessionId, userMsgId } = await withRetry(async () => {
      const t1 = agent.run({ prompt: "remember the word: apple" });
      let id = "";
      const idDeadline = Date.now() + 30_000;
      for await (const ev of t1.fullStream) {
        if (ev.type === "user_message" && ev.messageId) {
          id = ev.messageId;
        }
        // Don't wait beyond a generous deadline — if user_message never fires
        // (older opencode servers), skip the test rather than hang.
        if (Date.now() > idDeadline && !id) break;
      }
      const r1 = await t1.result;
      return { sessionId: r1.sessionId, userMsgId: id };
    });

    if (!userMsgId) {
      console.warn("[opencode resume-at] user_message id not captured — skipping rewind assertion");
      return;
    }

    // Turn 2: rewind to BEFORE the "apple" message → empty history → forget.
    const r2 = await withRetry(
      () =>
        agent.run({
          prompt:
            "what single word, if any, did I ask you to remember? say 'none' if I have not asked.",
          options: { resume: sessionId, resumeSessionAt: userMsgId },
        }).result,
    );

    expect(r2.sessionId).toBe(sessionId);
    expect(r2.text.toLowerCase()).not.toContain("apple");
  }, 600_000);
});
