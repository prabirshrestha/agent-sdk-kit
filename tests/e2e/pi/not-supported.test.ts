// pi CLI: matrix cells documented as ✗ (not_supported).
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("pi");
const provider = () => pi({ cwd: process.cwd() });

describe.skipIf(!enabled)("pi / not-supported", () => {
  test("sessionId pin → not_supported", async () => {
    await using agent = createAgent({ provider: provider() });
    await expect(
      agent.run({
        prompt: "hi",
        options: { sessionId: "00000000-0000-0000-0000-000000000000" },
      }).result,
    ).rejects.toMatchObject({ kind: "not_supported" });
  }, 30_000);

  test("resumeSessionAt → not_supported", async () => {
    await using agent = createAgent({ provider: provider() });
    await expect(
      agent.run({
        prompt: "hi",
        options: {
          resume: "00000000-0000-0000-0000-000000000000",
          resumeSessionAt: "msg_x",
        },
      }).result,
    ).rejects.toMatchObject({ kind: "not_supported" });
  }, 30_000);

  test("forkSession + resumeSessionAt → not_supported", async () => {
    await using agent = createAgent({ provider: provider() });
    await expect(
      agent.run({
        prompt: "hi",
        options: {
          resume: "00000000-0000-0000-0000-000000000000",
          forkSession: true,
          resumeSessionAt: "msg_x",
          providerOptions: { pi: { fork: true } },
        },
      }).result,
    ).rejects.toMatchObject({ kind: "not_supported" });
  }, 30_000);
});
