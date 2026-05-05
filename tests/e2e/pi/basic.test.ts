// pi CLI: basic lifecycle + provider factory metadata.
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";

const enabled = await e2eGate("pi");
const provider = () => pi({ cwd: process.cwd() });

describe("pi / factory", () => {
  test("factory returns ProviderImpl with correct metadata", () => {
    const p = provider();
    expect(p.name).toBe("pi");
    expect(p.transport).toBe("cli");
    expect(typeof p.stream).toBe("function");
    expect(typeof p.dispose).toBe("function");
  });
});

describe.skipIf(!enabled)("pi / basic", () => {
  test("start → sessionId is non-empty + text contains pong + provider tag", async () => {
    await using agent = createAgent({ provider: provider() });
    const result = await agent.run({ prompt: "reply with exactly: pong" }).result;
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("pi");
  }, 120_000);

  test("textStream concatenates to final text", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });
    const chunks: string[] = [];
    for await (const c of turn.textStream) chunks.push(c);
    await turn.result;
    expect(chunks.join("").toLowerCase()).toContain("pong");
  }, 120_000);

  test("fullStream ordering invariant holds", async () => {
    await using agent = createAgent({ provider: provider() });
    const events = await collectFullStream(agent.run({ prompt: "reply with exactly: pong" }));
    assertLifecycleOrdering(events, { label: "pi/basic" });
  }, 120_000);
});
