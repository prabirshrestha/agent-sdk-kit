import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../src/index.js";

// Check if pi is available on the system
const piAvailable = await Bun.$`which pi`
  .quiet()
  .nothrow()
  .then((r) => r.exitCode === 0);

const provider = () => pi({ cwd: process.cwd() });

describe("pi provider", () => {
  test("factory returns ProviderImpl with correct metadata", () => {
    const p = provider();
    expect(p.name).toBe("pi");
    expect(p.transport).toBe("cli");
    expect(typeof p.stream).toBe("function");
    expect(typeof p.dispose).toBe("function");
  });
});

describe.skipIf(!piAvailable)("pi e2e", () => {
  test("start → collect sessionId + text", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });
    const result = await turn.result;

    expect(result.sessionId).toBeTruthy();
    // Pi sessions are filesystem paths, not UUIDs
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("pi");
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
    // result is last (or near end)
    const sessionIdx = eventTypes.indexOf("session");
    const turnStartIdx = eventTypes.indexOf("turn_start");
    const firstTextDeltaIdx = eventTypes.indexOf("text_delta");
    const turnEndIdx = eventTypes.indexOf("turn_end");
    const resultIdx = eventTypes.indexOf("result");

    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    if (turnStartIdx >= 0) {
      expect(turnStartIdx).toBeGreaterThanOrEqual(sessionIdx);
    }
    if (firstTextDeltaIdx >= 0 && turnStartIdx >= 0) {
      expect(firstTextDeltaIdx).toBeGreaterThan(turnStartIdx);
    }
    if (turnEndIdx >= 0 && firstTextDeltaIdx >= 0) {
      expect(turnEndIdx).toBeGreaterThan(firstTextDeltaIdx);
    }
    if (resultIdx >= 0 && turnEndIdx >= 0) {
      expect(resultIdx).toBeGreaterThan(turnEndIdx);
    }
  }, 120_000);

  test("resume → continues session", async () => {
    await using agent = createAgent({ provider: provider() });

    const turn1 = agent.run({ prompt: "remember the word: banana" });
    const result1 = await turn1.result;
    const sessionId = result1.sessionId;

    expect(sessionId).toBeTruthy();

    const turn2 = agent.run({
      prompt: "what word did I ask you to remember? reply with just the word",
      options: { resume: sessionId },
    });
    const result2 = await turn2.result;

    expect(result2.text.toLowerCase()).toContain("banana");
    expect(result2.sessionId).toBe(sessionId);
  }, 180_000);

  test("native resume invariant — sessionId is a stable identifier", async () => {
    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({ prompt: "reply with exactly: pong" });
    const result = await turn.result;

    // Pi emits a UUID as the session id in its `session` event. `pi --session
    // <uuid>` resolves within the current cwd's project-slugified directory
    // under ~/.pi/agent/sessions/. The core invariant is just that it's a
    // non-empty string identifier the SDK can round-trip to resume.
    expect(typeof result.sessionId).toBe("string");
    expect(result.sessionId.length).toBeGreaterThan(0);
  }, 120_000);

  test("fork → creates new session from existing", async () => {
    await using agent = createAgent({ provider: provider() });

    const turn1 = agent.run({ prompt: "remember the word: apple" });
    const result1 = await turn1.result;
    const sourceSessionId = result1.sessionId;

    expect(sourceSessionId).toBeTruthy();

    const turn2 = agent.run({
      prompt: "what word was mentioned? add 'forked:' before it",
      options: {
        resume: sourceSessionId,
        forkSession: true,
        providerOptions: { pi: { fork: true } },
      },
    });
    const result2 = await turn2.result;

    // Forked session should have a different ID
    expect(result2.sessionId).not.toBe(sourceSessionId);
    expect(result2.text.toLowerCase()).toContain("apple");
    expect(result2.text.toLowerCase()).toContain("forked");
  }, 180_000);
});
