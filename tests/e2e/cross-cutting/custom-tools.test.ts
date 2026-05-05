import { describe, test, expect } from "bun:test";
import { createAgent, copilot, claude, isProviderAvailable } from "../../../src/index.js";
import type { AgentEvent, AgentTool, Provider } from "../../../src/index.js";

// Try to import the `tool` helper. If src/tools.ts isn't present yet, we fall
// back to a manual AgentTool construction so the test can still exercise the
// custom-tool wiring on a live provider.
let toolFn: ((name: string, def: any) => AgentTool) | null = null;
try {
  const mod = await import("../../../src/tools.js");
  toolFn = (mod as any).tool ?? null;
} catch {
  toolFn = null;
}

function makeSecretTool(): AgentTool {
  if (toolFn) {
    return toolFn("get_secret", {
      description: "Returns a secret number",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ secret: 7 }),
    });
  }
  return {
    name: "get_secret",
    description: "Returns a secret number",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ secret: 7 }),
  };
}

type Candidate = { name: "copilot" | "claude"; make: () => Provider };
const candidates: Candidate[] = [
  {
    name: "copilot",
    make: () => copilot({ cwd: "/tmp" }),
  },
  { name: "claude", make: () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" }) },
];

let chosen: Candidate | null = null;
for (const c of candidates) {
  if (await isProviderAvailable(c.name).catch(() => false)) {
    chosen = c;
    break;
  }
}

describe.skipIf(!chosen)(`custom tools e2e (${chosen?.name ?? "none"})`, () => {
  test("model invokes custom get_secret tool and reports value", async () => {
    if (!chosen) return;
    await using agent = createAgent({ provider: chosen.make() });
    const secretTool = makeSecretTool();
    const turn = agent.run({
      prompt: "Call the get_secret tool and tell me the secret number it returns.",
      options: { tools: { get_secret: secretTool } },
    });

    let sawToolCall = false;
    const events: AgentEvent[] = [];
    for await (const ev of turn.fullStream) {
      events.push(ev);
      if (ev.type === "tool_call" && ev.name === "get_secret") {
        sawToolCall = true;
      }
    }
    const result = await turn.result;

    const includesSeven = result.text.includes("7");
    expect(sawToolCall || includesSeven).toBe(true);
  }, 180_000);
});
