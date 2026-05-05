// opencode SDK: matrix cells documented as ✗ (not_supported).
//
// pinnedSessionId — server assigns the session id (no way to pre-pin).
import { describe, test, expect } from "bun:test";
import { createAgent, opencode } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("opencode-sdk");
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-4o" } as const;

describe.skipIf(!enabled)("opencode SDK / not-supported", () => {
  test("pinnedSessionId throws not_supported (matrix says ✗)", async () => {
    await using agent = createAgent({ provider: opencode(ocConfig) });
    await expect(
      agent.run({
        prompt: "reply with exactly: pong",
        options: { sessionId: "ses_pinned_should_reject" },
      }).result,
    ).rejects.toMatchObject({
      kind: "not_supported",
      code: "pinned_session_id_unsupported",
    });
  }, 60_000);
});
