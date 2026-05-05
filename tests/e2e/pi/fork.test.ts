// pi CLI: forkSession via providerOptions.pi.fork.
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("pi");
const provider = () => pi({ cwd: process.cwd() });

describe.skipIf(!enabled)("pi / fork", () => {
  test("fork creates a new session id and inherits parent context", async () => {
    await using agent = createAgent({ provider: provider() });
    const r1 = await agent.run({ prompt: "remember the word: apple" }).result;
    const r2 = await agent.run({
      prompt: "what word was mentioned? add 'forked:' before it",
      options: {
        resume: r1.sessionId,
        forkSession: true,
        providerOptions: { pi: { fork: true } },
      },
    }).result;

    expect(r2.sessionId).not.toBe(r1.sessionId);
    expect(r2.text.toLowerCase()).toContain("apple");
    expect(r2.text.toLowerCase()).toContain("forked");
  }, 180_000);
});
