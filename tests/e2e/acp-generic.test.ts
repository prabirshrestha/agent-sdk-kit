import { describe, test, expect } from "bun:test";
import { createAgent, acp } from "../../src/index.js";

/** Retry helper for transient errors. */
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 5_000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable =
        msg.includes("Forbidden") ||
        msg.includes("403") ||
        msg.includes("rate limit") ||
        msg.includes("spawn") ||
        msg.includes("connection");

      if (!isRetryable || i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

describe("acp e2e (generic)", () => {
  test("start with copilot --acp → collect sessionId + text", async () => {
    await using agent = createAgent({
      provider: acp({
        spawn: ["copilot", "--acp"],
      }),
    });

    const result = await withRetry(async () => {
      const turn = agent.run({ prompt: "reply with exactly: pong" });
      return await turn.result;
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("acp");
  }, 60_000);

  test("start with copilot --acp → stream text deltas", async () => {
    await using agent = createAgent({
      provider: acp({
        spawn: ["copilot", "--acp"],
      }),
    });

    const fullText = await withRetry(async () => {
      const turn = agent.run({ prompt: "reply with exactly: pong" });
      turn.result.catch(() => {}); // suppress unhandled rejection during iteration

      const chunks: string[] = [];
      for await (const chunk of turn.textStream) {
        chunks.push(chunk);
      }

      await turn.result; // surface any error for retry
      return chunks.join("");
    });

    expect(fullText.toLowerCase()).toContain("pong");
  }, 60_000);

  test("start → fullStream event ordering", async () => {
    await using agent = createAgent({
      provider: acp({
        spawn: ["copilot", "--acp"],
      }),
    });

    const eventTypes = await withRetry(async () => {
      const turn = agent.run({ prompt: "reply with exactly: pong" });
      turn.result.catch(() => {}); // suppress unhandled rejection during iteration

      const types: string[] = [];
      for await (const event of turn.fullStream) {
        types.push(event.type);
      }

      await turn.result; // surface any error for retry
      return types;
    });

    const sessionIdx = eventTypes.indexOf("session");
    const turnStartIdx = eventTypes.indexOf("turn_start");
    const resultIdx = eventTypes.indexOf("result");

    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(turnStartIdx).toBeGreaterThan(sessionIdx);
    expect(resultIdx).toBeGreaterThan(turnStartIdx);
  }, 60_000);

  test.skip("resume → continues session", async () => {
    // Skip: Resume across calls would require keeping the ACP connection alive
    // for the lifetime of the Agent. Currently each stream() call spawns a fresh
    // copilot --acp process, and ACP sessions die with their connection.
    // Future work: hold a persistent ACP client at the Provider level.
    await using agent = createAgent({
      provider: acp({
        spawn: ["copilot", "--acp"],
      }),
    });

    const result1 = await withRetry(async () => {
      const turn1 = agent.run({ prompt: "remember the word: banana" });
      return await turn1.result;
    });

    const result2 = await withRetry(async () => {
      const turn2 = agent.run({
        prompt: "what word did I ask you to remember? reply with just the word",
        options: { resume: result1.sessionId },
      });
      return await turn2.result;
    });

    expect(result2.text.toLowerCase()).toContain("banana");
  }, 120_000);

  test("fork → throws not_supported error", async () => {
    await using agent = createAgent({
      provider: acp({
        spawn: ["copilot", "--acp"],
      }),
    });

    const result1 = await withRetry(async () => {
      const turn1 = agent.run({ prompt: "reply with exactly: pong" });
      return await turn1.result;
    });

    // Fork should throw an error
    await expect(async () => {
      const turn2 = agent.run({
        prompt: "reply with exactly: pong",
        options: { resume: result1.sessionId, forkSession: true },
      });
      await turn2.result;
    }).toThrow();
  }, 120_000);
});
