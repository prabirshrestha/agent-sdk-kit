// pi SDK transport: basic lifecycle + custom tool + custom provider.
// Requires `@mariozechner/pi-coding-agent` peer dep AND a pi-compatible
// model credential (e.g. ANTHROPIC_API_KEY) — the SDK calls the model
// directly, not via the `pi` CLI binary.
import { describe, test, expect } from "bun:test";
import { createAgent, pi } from "../../../src/index.js";
import { e2eGate, assertLifecycleOrdering, collectFullStream } from "../_helpers.js";
import type { AgentTool } from "../../../src/index.js";

// We gate on pi (the CLI presence + RUN_E2E_PI=1) AND on the SDK peer being
// importable. The CLI presence implies the user has a pi install on PATH; the
// SDK transport itself doesn't strictly need the CLI, but we reuse the gate
// to keep credential expectations consistent with other pi e2e files.
const piEnabled = await e2eGate("pi");
let sdkAvailable = false;
try {
  await import("@mariozechner/pi-coding-agent");
  sdkAvailable = true;
} catch {
  sdkAvailable = false;
}
const enabled = piEnabled && sdkAvailable;

const provider = () => pi({ cwd: process.cwd(), transport: "sdk" });

describe("pi (SDK) / factory", () => {
  test("factory returns ProviderImpl with transport='sdk'", () => {
    const p = provider();
    expect(p.name).toBe("pi");
    expect(p.transport).toBe("sdk");
    expect(typeof p.stream).toBe("function");
    expect(typeof p.dispose).toBe("function");
  });
});

describe.skipIf(!enabled)("pi (SDK) / basic", () => {
  test("start → result contains pong + lifecycle ordering ok", async () => {
    await using agent = createAgent({ provider: provider() });
    const events = await collectFullStream(agent.run({ prompt: "reply with exactly: pong" }));
    assertLifecycleOrdering(events, { label: "pi-sdk/basic" });
    const result = events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    const text =
      result && "text" in result && typeof (result as { text: unknown }).text === "string"
        ? (result as { text: string }).text
        : "";
    expect(text.toLowerCase()).toContain("pong");
  }, 180_000);

  test("custom tool: model calls it and result surfaces in stream", async () => {
    const calls: Array<unknown> = [];
    const echoTool: AgentTool = {
      name: "echo",
      description: "Echo back the provided text exactly",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      async execute(input) {
        calls.push(input);
        return { content: [{ type: "text", text: `echoed:${JSON.stringify(input)}` }] };
      },
    };

    await using agent = createAgent({ provider: provider() });
    const events = await collectFullStream(
      agent.run({
        prompt: "Call the `echo` tool with text='hi', then reply with just: done",
        options: { tools: { echo: echoTool } },
      }),
    );
    assertLifecycleOrdering(events, { label: "pi-sdk/customtool" });
    const toolCall = events.find((e) => e.type === "tool_call");
    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(calls.length).toBeGreaterThan(0);
  }, 240_000);
});
