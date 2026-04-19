import { describe, test, expect } from "bun:test";
import { createAgent, copilot } from "../../src/index.js";

// Check if SDK is available
let sdkAvailable = false;
try {
  await import("@github/copilot-sdk");
  sdkAvailable = true;
} catch {
  console.log("⚠️  Skipping Copilot SDK tests — @github/copilot-sdk not installed");
}

describe.skipIf(!sdkAvailable)("copilot SDK e2e", () => {
  test(
    "start → collect sessionId + text",
    async () => {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });

      const turn = agent.run({ prompt: "reply with exactly: pong" });
      const result = await turn.result;

      // sessionId should be a UUID
      expect(result.sessionId).toBeTruthy();
      expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);

      // text should contain pong
      expect(result.text.toLowerCase()).toContain("pong");

      expect(result.provider).toBe("copilot");
    },
    { timeout: 120_000 },
  );

  test(
    "start → stream text deltas",
    async () => {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
      const turn = agent.run({ prompt: "reply with exactly: pong" });

      const chunks: string[] = [];
      for await (const chunk of turn.textStream) {
        chunks.push(chunk);
      }

      const fullText = chunks.join("");
      expect(fullText.toLowerCase()).toContain("pong");
    },
    { timeout: 120_000 },
  );

  test(
    "start → fullStream event ordering",
    async () => {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
      const turn = agent.run({ prompt: "reply with exactly: pong" });

      const eventTypes: string[] = [];
      for await (const event of turn.fullStream) {
        eventTypes.push(event.type);
      }

      // For SDK transport, session event comes first (emitted immediately)
      const sessionIdx = eventTypes.indexOf("session");
      const turnStartIdx = eventTypes.indexOf("turn_start");
      const turnEndIdx = eventTypes.indexOf("turn_end");
      const resultIdx = eventTypes.indexOf("result");

      expect(sessionIdx).toBe(0); // Session event should be first
      expect(turnStartIdx).toBeGreaterThan(sessionIdx);
      expect(turnEndIdx).toBeGreaterThan(turnStartIdx);
      expect(resultIdx).toBeGreaterThan(turnEndIdx);
    },
    { timeout: 120_000 },
  );

  test(
    "resume → continues session",
    async () => {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });

      // Start a session
      const turn1 = agent.run({ prompt: "remember the word: banana" });
      const result1 = await turn1.result;
      const sessionId = result1.sessionId;

      // Resume the session
      const turn2 = agent.run({
        prompt: "what word did I ask you to remember? reply with just the word",
        options: { resume: sessionId },
      });
      const result2 = await turn2.result;

      expect(result2.text.toLowerCase()).toContain("banana");
    },
    { timeout: 180_000 },
  );

  test(
    "native resume invariant — session directory exists",
    async () => {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
      const turn = agent.run({ prompt: "reply with exactly: pong" });
      const result = await turn.result;

      // Copilot stores sessions at ~/.copilot/session-state/<uuid>/
      const { existsSync } = await import("fs");
      const { homedir } = await import("os");
      const path = await import("path");

      const sessionDir = path.join(homedir(), ".copilot", "session-state", result.sessionId);
      expect(existsSync(sessionDir)).toBe(true);
    },
    { timeout: 120_000 },
  );

  test(
    "transport is reported as sdk",
    async () => {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });

      expect(agent.transport).toBe("sdk");
    },
    { timeout: 5_000 },
  );
});
