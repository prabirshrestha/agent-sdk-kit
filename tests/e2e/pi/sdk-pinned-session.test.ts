// pi SDK: pinnedSessionId (options.sessionId on a new session).
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const piEnabled = await e2eGate("pi");
let sdkAvailable = false;
try {
  await import("@mariozechner/pi-coding-agent");
  sdkAvailable = true;
} catch {
  sdkAvailable = false;
}
const enabled = piEnabled && sdkAvailable;

const provider = () => pi({ cwd: process.cwd(), transport: "sdk" });

describe.skipIf(!enabled)("pi (SDK) / pinned-session", () => {
  test("pinnedSessionId is honored — returned sessionId matches caller-supplied uuid", async () => {
    await using agent = createAgent({ provider: provider() });
    const pinned = crypto.randomUUID();
    const result = await agent.run({
      prompt: "reply with exactly: pong",
      options: { sessionId: pinned },
    }).result;
    expect(result.sessionId).toBe(pinned);
  }, 120_000);
});
