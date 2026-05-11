// pi SDK: per-call `options.model` overrides config.model.
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

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

describe.skipIf(!enabled)("pi (SDK) / model-override", () => {
  test("per-call options.model overrides default for a single turn", async () => {
    await using agent = createAgent({ provider: provider() });
    // Use github-copilot/claude-sonnet-4.5 — pi-ai registry exposes this
    // model and it's available across most copilot subscription tiers
    // (gpt-4.1 returns 421 Misdirected Request on some enterprise endpoints).
    // Format is "<provider>/<modelId>".
    const events = await collectFullStream(
      agent.run({
        prompt: "reply with exactly: pong",
        options: { model: "github-copilot/claude-sonnet-4.5" },
      }),
    );
    assertLifecycleOrdering(events, { label: "pi-sdk/model-override" });
    const result = events.find((e) => e.type === "result") as unknown as { text: string };
    expect(result.text.toLowerCase()).toContain("pong");
  }, 180_000);
});
