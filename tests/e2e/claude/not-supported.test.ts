// claude CLI: matrix cells documented as ✗ (not_supported).
//
// These tests are essentially synchronous — they verify the kit fails fast
// before spawning the CLI when an unsupported option combo is requested.
import { describe, test, expect } from "bun:test";
import { createAgent, claude } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("claude");
const provider = () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" });

describe.skipIf(!enabled)("claude / not-supported", () => {
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
        },
      }).result,
    ).rejects.toMatchObject({ kind: "not_supported" });
  }, 30_000);
});
