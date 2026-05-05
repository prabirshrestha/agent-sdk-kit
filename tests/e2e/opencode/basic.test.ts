// opencode SDK: basic lifecycle (start, stream, ordering, sessionId shape).
import { describe, test, expect } from "bun:test";
import { createAgent, opencode } from "../../../src/index.js";
import { e2eGate, withRetry, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

const enabled = await e2eGate("opencode-sdk");
// gpt-4o has higher TPM than gpt-4.1 → fewer 403s.
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-4o" } as const;

describe.skipIf(!enabled)("opencode SDK / basic", () => {
  test("start → sessionId starts with `ses_` + text contains pong + provider tag", async () => {
    await using agent = createAgent({ provider: opencode(ocConfig) });
    const result = await withRetry(() => agent.run({ prompt: "reply with exactly: pong" }).result);
    expect(result.sessionId).toMatch(/^ses_/);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("opencode");
  }, 120_000);

  test("textStream concatenates to final text", async () => {
    await using agent = createAgent({ provider: opencode(ocConfig) });
    const text = await withRetry(async () => {
      const turn = agent.run({ prompt: "reply with exactly: pong" });
      turn.result.catch(() => {});
      const chunks: string[] = [];
      for await (const c of turn.textStream) chunks.push(c);
      await turn.result;
      return chunks.join("");
    });
    expect(text.toLowerCase()).toContain("pong");
  }, 120_000);

  test("fullStream ordering invariant holds", async () => {
    await using agent = createAgent({ provider: opencode(ocConfig) });
    const events = await withRetry(() =>
      collectFullStream(agent.run({ prompt: "reply with exactly: pong" })),
    );
    assertLifecycleOrdering(events, { label: "opencode/basic" });
  }, 120_000);
});
