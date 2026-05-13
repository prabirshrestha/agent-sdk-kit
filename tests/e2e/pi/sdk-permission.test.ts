// pi SDK permission-flow e2e — exercises the `needsApproval` custom-
// tool path. Unlike Copilot/Opencode (which gate the SDK's built-in
// tools), the pi transport gates only custom tools where the kit's
// `tool({ needsApproval: true })` predicate is set. See
// sdk-pi.ts:215-228 (gate around tool execute) and sdk-pi.ts:664-674
// (where the user's `opts.onPermissionRequest` is invoked).
//
// pi correctly uses `result.decision === "allow"` already, so this is
// a contract pin — not a fix verification. If a future refactor
// regresses the shape, this test catches it.

import { describe, expect, test } from "bun:test";

import { createAgent, pi } from "../../../src/index.js";
import type { AgentEvent, AgentTool } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

// Build the tool manually (without the kit's `tool()` wrapper) so we
// hit pi's transport-level gate exclusively. The kit's `tool()` wrap
// adds its own `ctx.emit`-driven gate that would deadlock here: pi's
// transport already calls `opts.onPermissionRequest` and runs
// `execute`, but the wrapper would re-emit permission_request and
// wait for a respond() that never comes.
function makeGatedTool(execute: () => Promise<unknown>): AgentTool {
  return {
    name: "ping_server",
    description: "Pings a server and returns the latency. Always call this tool when asked.",
    inputSchema: { type: "object", properties: {} },
    needsApproval: true,
    execute,
  };
}

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

describe.skipIf(!enabled)("pi (SDK) / permission flow", () => {
  test("`{ decision: 'allow' }` lets the gated custom tool execute", async () => {
    let permissionRequests = 0;
    let executed = false;
    const ping = makeGatedTool(async () => {
      executed = true;
      return { ok: true, latencyMs: 42 };
    });

    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({
      prompt: "Call the ping_server tool to measure server latency, then tell me the result.",
      options: {
        tools: { ping_server: ping },
        onPermissionRequest: async () => {
          permissionRequests++;
          return { decision: "allow" };
        },
      },
    });

    let streamThrew: unknown = null;
    const events: AgentEvent[] = [];
    try {
      for await (const ev of turn.fullStream) {
        events.push(ev);
        if (ev.type === "error") streamThrew = ev.message;
      }
    } catch (err) {
      streamThrew = err;
    }
    const result = await turn.result;

    expect(streamThrew).toBeNull();
    expect(typeof result.text).toBe("string");
    // When permission was requested, allow must have unblocked
    // the tool's execute() and let it set `executed = true`.
    // Conditional in case the model chose not to call the tool
    // this run.
    if (permissionRequests > 0) {
      expect(executed).toBe(true);
    }
  }, 180_000);

  test("`{ decision: 'deny' }` blocks the gated custom tool", async () => {
    let permissionRequests = 0;
    let executed = false;
    const ping = makeGatedTool(async () => {
      executed = true;
      return { ok: true, latencyMs: 42 };
    });

    await using agent = createAgent({ provider: provider() });
    const turn = agent.run({
      prompt: "Call the ping_server tool to measure server latency.",
      options: {
        tools: { ping_server: ping },
        onPermissionRequest: async () => {
          permissionRequests++;
          return { decision: "deny", reason: "test-deny" };
        },
      },
    });

    let streamThrew: unknown = null;
    try {
      for await (const ev of turn.fullStream) {
        if (ev.type === "error") streamThrew = ev.message;
      }
    } catch (err) {
      streamThrew = err;
    }
    const result = await turn.result;

    expect(streamThrew).toBeNull();
    expect(typeof result.text).toBe("string");
    // Deny path: the tool's execute() must NOT have run.
    if (permissionRequests > 0) {
      expect(executed).toBe(false);
    }
  }, 180_000);
});
