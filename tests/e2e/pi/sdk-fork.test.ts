// pi SDK: forkSession (new sessionId, parent context inherited).
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

describe.skipIf(!enabled)("pi (SDK) / fork", () => {
  test("fork creates a new sessionId and inherits parent context", async () => {
    await using agent = createAgent({ provider: provider() });
    const r1 = await agent.run({ prompt: "remember the word: banana" }).result;
    const r2 = await agent.run({
      prompt: "what word did I ask you to remember? reply with just the word",
      options: { resume: r1.sessionId, forkSession: true },
    }).result;

    expect(r2.sessionId.length).toBeGreaterThan(0);
    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("banana");
  }, 240_000);
});
