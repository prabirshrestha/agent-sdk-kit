// copilot SDK: per-call `options.model` overrides SessionConfig.model.
import { describe, test, expect } from "bun:test";
import { createAgent, copilot } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

const enabled = await e2eGate("copilot-sdk");

describe.skipIf(!enabled)("copilot SDK / model-override", () => {
  test("per-call options.model overrides default for a single turn", async () => {
    await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
    // Use gpt-4.1 — broadly available across copilot subscription tiers.
    // (Note: copilot model ids use dots not dashes, e.g. claude-sonnet-4.5.)
    const events = await collectFullStream(
      agent.run({
        prompt: "reply with exactly: pong",
        options: { model: "gpt-4.1" },
      }),
    );
    assertLifecycleOrdering(events, { label: "copilot/model-override" });
    const result = events.find((e) => e.type === "result") as unknown as { text: string };
    expect(result.text.toLowerCase()).toContain("pong");
  }, 120_000);
});
