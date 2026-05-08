// opencode SDK: per-call `options.model` overrides config.model.
//
// Format: "providerID/modelID" (e.g. "github-copilot/gpt-5-mini").
import { describe, test, expect } from "bun:test";
import { createAgent, opencode } from "../../../src/index.js";
import {
  e2eGate,
  consumeTurnWithRetry,
  assertLifecycleOrdering,
  collectFullStream,
} from "../_helpers.js";

const enabled = await e2eGate("opencode-sdk");
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-5-mini" } as const;

describe.skipIf(!enabled)("opencode SDK / model-override", () => {
  test("per-call options.model overrides default for one turn", async () => {
    await using agent = createAgent({ provider: opencode(ocConfig) });
    const events = await consumeTurnWithRetry(
      () =>
        agent.run({
          prompt: "reply with exactly: pong",
          options: { model: "github-copilot/gpt-5-mini" },
        }),
      (turn) => collectFullStream(turn),
    );
    assertLifecycleOrdering(events, { label: "opencode/model-override" });
    const result = events.find((e) => e.type === "result") as unknown as { text: string };
    expect(result.text.toLowerCase()).toContain("pong");
  }, 120_000);
});
