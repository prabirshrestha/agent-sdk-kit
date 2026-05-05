// ACP: per-call `model` override is forwarded via the (UNSTABLE) session/set_model
// RPC when the agent advertises NewSessionResponse.models.
//
// copilot --acp DOES advertise models, so the kit attempts setSessionModel.
// An unknown model id triggers a JSON-RPC -32602 → wrapped into AgentError.
// Either way, observing AgentError proves the override was forwarded.
import { describe, test, expect } from "bun:test";
import { createAgent, acp } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";
import { AgentError } from "../../../src/errors.js";

const enabled = await e2eGate("acp");
const provider = () => acp({ spawn: ["copilot", "--acp"] });

describe.skipIf(!enabled)("acp / model-override", () => {
  test("per-call options.model is forwarded to the ACP agent", async () => {
    await using agent = createAgent({ provider: provider() });
    await expect(
      agent.run({
        prompt: "reply with exactly: pong",
        options: { model: "definitely-not-a-real-model-id" },
      }).result,
    ).rejects.toBeInstanceOf(AgentError);
  }, 60_000);
});
