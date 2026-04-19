import { describe, test, expect } from "bun:test";
import { createAgent, claude } from "../../src/index.js";

const provider = () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" });

describe("claude e2e", () => {
  test("start → collect sessionId + text", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });
    const result = await turn.result;

    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("claude");
  }, 120_000);

  test("start → stream text deltas", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });

    const events: string[] = [];
    for await (const chunk of turn.textStream) {
      events.push(chunk);
    }

    const fullText = events.join("");
    expect(fullText.toLowerCase()).toContain("pong");
  }, 120_000);

  test("start → fullStream event ordering", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });

    const eventTypes: string[] = [];
    for await (const event of turn.fullStream) {
      eventTypes.push(event.type);
    }

    // Verify event ordering per §6.2:
    // session comes first (or early)
    // turn_start before text_delta
    // turn_end after text_delta
    // result is last
    const sessionIdx = eventTypes.indexOf("session");
    const turnStartIdx = eventTypes.indexOf("turn_start");
    const firstTextDeltaIdx = eventTypes.indexOf("text_delta");
    const turnEndIdx = eventTypes.indexOf("turn_end");
    const resultIdx = eventTypes.indexOf("result");

    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(turnStartIdx).toBeGreaterThan(sessionIdx);
    if (firstTextDeltaIdx >= 0) {
      expect(firstTextDeltaIdx).toBeGreaterThan(turnStartIdx);
      expect(turnEndIdx).toBeGreaterThan(firstTextDeltaIdx);
    }
    expect(resultIdx).toBeGreaterThan(turnEndIdx);
  }, 120_000);

  test("resume → continues session", async () => {
    await using agent = createAgent({ provider: provider() });

    const turn1 = agent.run({ prompt: "remember the word: banana" });
    const result1 = await turn1.result;
    const sessionId = result1.sessionId;

    const turn2 = agent.run({
      prompt: "what word did I ask you to remember? reply with just the word",
      options: { resume: sessionId },
    });
    const result2 = await turn2.result;

    expect(result2.text.toLowerCase()).toContain("banana");
    expect(result2.sessionId).toBe(sessionId);
  }, 180_000);

  test("native resume invariant — sessionId is UUID", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });
    const result = await turn.result;

    // The core invariant: sessionId is a valid UUID that works with `claude --resume`
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);
});
