// copilot SDK: pinnedSessionId (options.sessionId on a new session).
import { describe, test, expect } from "bun:test";
import { createAgent, copilot } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("copilot-sdk");

describe.skipIf(!enabled)("copilot SDK / pinned-session", () => {
  test("pinnedSessionId is honored — returned sessionId matches caller-supplied uuid", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    const pinned = crypto.randomUUID();
    const result = await agent.run({
      prompt: "reply with exactly: pong",
      options: { sessionId: pinned },
    }).result;
    expect(result.sessionId).toBe(pinned);
  }, 120_000);
});
