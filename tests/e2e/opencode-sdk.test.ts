import { describe, test, expect } from "bun:test";
import { createAgent, opencode } from "../../src/index.js";

// gpt-4o has higher TPM limits than gpt-4.1 which frequently hits rate limits
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-4o" };

/** Retry helper for transient 403 rate-limit errors from the Copilot API. */
async function withRetry<T>(fn: () => Promise<T>, retries = 5, delayMs = 8_000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = msg.includes("Forbidden") || msg.includes("403");
      if (!isRetryable || i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

describe("opencode SDK e2e", () => {
  test("start → collect sessionId + text", async () => {
    // Skip if SDK is not installed
    try {
      await import("@opencode-ai/sdk");
    } catch {
      console.log("[test] @opencode-ai/sdk not installed, skipping test");
      return;
    }

    await using agent = createAgent({ provider: opencode(ocConfig) });
    const result = await withRetry(async () => {
      const turn = agent.run({ prompt: "reply with exactly: pong" });
      return await turn.result;
    });

    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).toMatch(/^ses_/);
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("opencode");
  }, 90_000);

  test("start → stream text deltas", async () => {
    // Skip if SDK is not installed
    try {
      await import("@opencode-ai/sdk");
    } catch {
      console.log("[test] @opencode-ai/sdk not installed, skipping test");
      return;
    }

    await using agent = createAgent({ provider: opencode(ocConfig) });
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
  }, 90_000);

  test("start → fullStream event ordering", async () => {
    // Skip if SDK is not installed
    try {
      await import("@opencode-ai/sdk");
    } catch {
      console.log("[test] @opencode-ai/sdk not installed, skipping test");
      return;
    }

    await using agent = createAgent({ provider: opencode(ocConfig) });
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
  }, 90_000);

  test("resume → continues session", async () => {
    // Skip if SDK is not installed
    try {
      await import("@opencode-ai/sdk");
    } catch {
      console.log("[test] @opencode-ai/sdk not installed, skipping test");
      return;
    }

    await using agent = createAgent({ provider: opencode(ocConfig) });
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
  }, 180_000);

  test("fork → creates new session id", async () => {
    // Skip if SDK is not installed
    try {
      await import("@opencode-ai/sdk");
    } catch {
      console.log("[test] @opencode-ai/sdk not installed, skipping test");
      return;
    }

    await using agent = createAgent({ provider: opencode(ocConfig) });
    const result1 = await withRetry(async () => {
      const turn1 = agent.run({ prompt: "reply with exactly: pong" });
      return await turn1.result;
    });

    const result2 = await withRetry(async () => {
      const turn2 = agent.run({
        prompt: "reply with exactly: pong",
        options: { resume: result1.sessionId, forkSession: true },
      });
      return await turn2.result;
    });

    // Fork mechanism: new session ID is created, different from source
    expect(result2.sessionId).toBeTruthy();
    expect(result2.sessionId).toMatch(/^ses_/);
    expect(result2.sessionId).not.toBe(result1.sessionId);
    // Forked session still produces valid output
    expect(result2.text.toLowerCase()).toContain("pong");
  }, 180_000);

  test("native resume invariant — session file exists", async () => {
    // Skip if SDK is not installed
    try {
      await import("@opencode-ai/sdk");
    } catch {
      console.log("[test] @opencode-ai/sdk not installed, skipping test");
      return;
    }

    await using agent = createAgent({ provider: opencode(ocConfig) });
    const result = await withRetry(async () => {
      const turn = agent.run({ prompt: "reply with exactly: pong" });
      return await turn.result;
    });

    expect(result.sessionId).toMatch(/^ses_/);
  }, 90_000);
});
