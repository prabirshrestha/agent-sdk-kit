// ACP (generic, via copilot --acp): basic lifecycle.
import { describe, test, expect } from "bun:test";
import { createAgent, acp } from "../../../src/index.js";
import {
  e2eGate,
  runTurnWithRetry,
  consumeTurnWithRetry,
  assertLifecycleOrdering,
  collectFullStream,
} from "../_helpers.js";

const enabled = await e2eGate("acp");
const provider = () => acp({ spawn: ["copilot", "--acp"] });

describe.skipIf(!enabled)("acp / basic", () => {
  test("start → sessionId + text contains pong + provider tag", async () => {
    await using agent = createAgent({ provider: provider() });
    const result = await runTurnWithRetry(() => agent.run({ prompt: "reply with exactly: pong" }));
    expect(result.sessionId).toBeTruthy();
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.provider).toBe("acp");
  }, 60_000);

  test("textStream concatenates to final text", async () => {
    await using agent = createAgent({ provider: provider() });
    const text = await consumeTurnWithRetry(
      () => agent.run({ prompt: "reply with exactly: pong" }),
      async (turn) => {
      turn.result.catch(() => {});
      const chunks: string[] = [];
      for await (const c of turn.textStream) chunks.push(c);
      await turn.result;
      return chunks.join("");
      },
    );
    expect(text.toLowerCase()).toContain("pong");
  }, 60_000);

  test("fullStream: session → turn_start → ... → result (no turn_end on ACP today)", async () => {
    await using agent = createAgent({ provider: provider() });
    const events = await consumeTurnWithRetry(
      () => agent.run({ prompt: "reply with exactly: pong" }),
      (turn) => collectFullStream(turn),
    );
    const types = events.map((e) => e.type);
    const session = types.indexOf("session");
    const turnStart = types.indexOf("turn_start");
    const result = types.indexOf("result");
    const turnEnd = types.indexOf("turn_end");

    expect(session).toBeGreaterThanOrEqual(0);
    expect(turnStart).toBeGreaterThan(session);
    expect(result).toBeGreaterThan(turnStart);
    // ACP transport may or may not emit turn_end depending on the agent;
    // when it does, it must precede result.
    if (turnEnd >= 0) {
      assertLifecycleOrdering(events, { label: "acp/basic" });
    }
  }, 60_000);
});
