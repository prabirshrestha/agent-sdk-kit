// opencode SDK: resume / multi-turn (2-turn + 3-turn) and fork.
import { describe, test, expect } from "bun:test";
import { createAgent, opencode } from "../../../src/index.js";
import {
  e2eGate,
  retryScenario,
  runTurnWithRetry,
  consumeTurnWithRetry,
  assertLifecycleOrdering,
  collectFullStream,
} from "../_helpers.js";

const enabled = await e2eGate("opencode-sdk");
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-5-mini" } as const;

describe.skipIf(!enabled)("opencode SDK / resume", () => {
  test("2-turn resume preserves sessionId + context", async () => {
    const { r1, r2 } = await retryScenario(async () => {
      await using agent = createAgent({ provider: opencode(ocConfig) });
      const r1 = await runTurnWithRetry(
        () => agent.run({ prompt: "remember the word: banana" }),
        1,
        0,
        30_000,
      );
      const r2 = await runTurnWithRetry(
        () =>
          agent.run({
            prompt: "what word did I ask you to remember? reply with just the word",
            options: { resume: r1.sessionId },
          }),
        1,
        0,
        30_000,
      );
      return { r1, r2 };
    });
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("banana");
  }, 300_000);

  test("3-turn resume preserves context + fullStream ordering", async () => {
    const { r1, e2, r3 } = await retryScenario(async () => {
      await using agent = createAgent({ provider: opencode(ocConfig) });
      const r1 = await runTurnWithRetry(
        () => agent.run({ prompt: "remember the number 42" }),
        1,
        0,
        30_000,
      );
      const e2 = await consumeTurnWithRetry(
        () =>
          agent.run({
            prompt: "now also remember the color blue",
            options: { resume: r1.sessionId },
          }),
        (turn) => collectFullStream(turn),
        1,
        0,
        45_000,
      );
      const r3 = await runTurnWithRetry(
        () =>
          agent.run({
            prompt: "what number and color did I tell you? reply: <number> <color>",
            options: { resume: r1.sessionId },
          }),
        1,
        0,
        30_000,
      );
      return { r1, e2, r3 };
    });
    assertLifecycleOrdering(e2, { label: "opencode/resume t2" });

    expect(r3.sessionId).toBe(r1.sessionId);
    expect(r3.text.toLowerCase()).toContain("42");
    expect(r3.text.toLowerCase()).toContain("blue");
  }, 450_000);
});

describe.skipIf(!enabled)("opencode SDK / fork", () => {
  test("fork creates a new sessionId distinct from the source", async () => {
    const { r1, r2 } = await retryScenario(async () => {
      await using agent = createAgent({ provider: opencode(ocConfig) });
      const r1 = await runTurnWithRetry(
        () => agent.run({ prompt: "reply with exactly: pong" }),
        1,
        0,
        30_000,
      );
      const r2 = await runTurnWithRetry(
        () =>
          agent.run({
            prompt: "reply with exactly: pong",
            options: { resume: r1.sessionId, forkSession: true },
          }),
        1,
        0,
        30_000,
      );
      return { r1, r2 };
    });
    expect(r2.sessionId).toMatch(/^ses_/);
    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("pong");
  }, 300_000);
});
