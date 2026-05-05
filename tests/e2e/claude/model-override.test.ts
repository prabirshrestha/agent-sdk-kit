// claude CLI: per-call `model` override is forwarded as `--model <id>`.
//
// The CLI itself authorizes the model id; we just verify the call completes
// when a known-good model id is supplied per turn.
import { describe, test, expect } from "bun:test";
import { createAgent, claude } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

const enabled = await e2eGate("claude");

describe.skipIf(!enabled)("claude / model-override", () => {
  test("per-call options.model overrides the construction-time model", async () => {
    await using agent = createAgent({
      provider: claude({ cwd: "/tmp", model: "claude-sonnet-4-5" }),
    });
    const events = await collectFullStream(
      agent.run({
        prompt: "reply with exactly: pong",
        options: { model: "claude-haiku-4-5" },
      }),
    );
    assertLifecycleOrdering(events, { label: "claude/model-override" });
    const result = events.find((e) => e.type === "result") as unknown as { text: string };
    expect(result.text.toLowerCase()).toContain("pong");
  }, 120_000);
});
