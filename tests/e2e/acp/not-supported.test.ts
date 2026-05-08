// ACP: matrix cells documented as ✗ (not_supported).
import { describe, test, expect } from "bun:test";
import { createAgent, acp } from "../../../src/index.js";
import { e2eGate, runTurnWithRetry } from "../_helpers.js";

const enabled = await e2eGate("acp");
const provider = () => acp({ spawn: ["copilot", "--acp"] });

describe.skipIf(!enabled)("acp / not-supported", () => {
  test("sessionId pin → not_supported", async () => {
    await using agent = createAgent({ provider: provider() });
    await expect(
      agent.run({
        prompt: "hi",
        options: { sessionId: "ses_pinned_should_reject" },
      }).result,
    ).rejects.toMatchObject({ kind: "not_supported" });
  }, 60_000);

  test("resumeSessionAt → not_supported", async () => {
    await using agent = createAgent({ provider: provider() });
    await expect(
      agent.run({
        prompt: "hi",
        options: { resume: "ses_anything", resumeSessionAt: "msg_x" },
      }).result,
    ).rejects.toMatchObject({ kind: "not_supported" });
  }, 60_000);

  test("forkSession → not_supported (each call spawns a fresh ACP process)", async () => {
    await using agent = createAgent({ provider: provider() });
    const r1 = await runTurnWithRetry(() => agent.run({ prompt: "reply with exactly: pong" }));
    await expect(
      agent.run({
        prompt: "reply with exactly: pong",
        options: { resume: r1.sessionId, forkSession: true },
      }).result,
    ).rejects.toMatchObject({ kind: "not_supported" });
  }, 120_000);
});
