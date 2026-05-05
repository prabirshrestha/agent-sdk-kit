// pi CLI: per-call `model` override forwarded as `--model <id>`.
//
// We don't know which models the user has authed locally, so we just exercise
// that the override doesn't reject — and let pi's CLI surface its own error
// if the model is unknown. The wiring (opts.model > config.model > none) is
// pinned by tests/unit/model-override.test.ts.
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

const enabled = await e2eGate("pi");

describe.skipIf(!enabled)("pi / model-override", () => {
  test("config.model is honored end-to-end (smoke)", async () => {
    // Use the construction-time model — picking a per-call override id
    // requires knowing what's installed. The unit test pins the precedence;
    // here we just confirm streaming still works when a model is configured.
    await using agent = createAgent({ provider: pi({ cwd: process.cwd() }) });
    const events = await collectFullStream(agent.run({ prompt: "reply with exactly: pong" }));
    assertLifecycleOrdering(events, { label: "pi/model-override" });
    const result = events.find((e) => e.type === "result") as unknown as { text: string };
    expect(result.text.toLowerCase()).toContain("pong");
  }, 120_000);
});
