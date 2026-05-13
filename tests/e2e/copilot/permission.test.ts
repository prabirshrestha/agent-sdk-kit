// Copilot SDK permission-flow e2e — regression coverage for the
// PermissionDecision shape contract.
//
// The kit's public callback is documented as
// `(req) => PermissionDecision` where PermissionDecision is
// `{ decision: "allow" | "deny" }` (src/types.ts). The Copilot
// transport must translate that to the underlying SDK's
// `{ kind: "approve-once" | "reject" }` shape — callers should never
// have to think about per-provider shapes.
//
// Before the 0.0.8 fix the Copilot transport leaked the SDK's native
// shape through, causing `unexpected user permission response`
// mid-stream when callers returned the documented `{ decision: "allow" }`.
// This test would have caught that regression.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { copilot, createAgent } from "../../../src/index.js";
import type { AgentEvent } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("copilot-sdk");

describe.skipIf(!enabled)("copilot SDK / permission flow", () => {
  test("`{ decision: 'allow' }` lets the agent execute a gated built-in tool", async () => {
    // Real-flow regression test:
    //   1. Pre-create a sentinel file inside a tmp dir.
    //   2. Prompt the agent to read the file (forces the SDK to
    //      invoke its built-in `read` tool, which hits the
    //      permission gate).
    //   3. Our `onPermissionRequest` returns the kit's documented
    //      `{ decision: "allow" }` shape.
    //   4. The transport (sdk-copilot.ts via
    //      `translatePermissionDecision`) must translate to the
    //      Copilot SDK's native `{ kind: "approve-once" }` so the
    //      SDK doesn't throw `unexpected user permission response`.
    //   5. The agent reads the file and reports the sentinel back.
    //
    // Before the 0.0.8 fix, step 4 would throw mid-stream.
    const dir = mkdtempSync(join(tmpdir(), "agent-sdk-kit-perm-"));
    const target = join(dir, "sentinel.txt");
    const sentinel = "p3rm1ss10n-fl0w-sent1nel";
    writeFileSync(target, sentinel, "utf-8");
    let permissionRequests = 0;

    try {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
      const turn = agent.run({
        prompt: `Use your read tool to read the contents of ${target} and reply with EXACTLY the file contents verbatim. Nothing else.`,
        options: {
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
      // SECONDARY: when the model actually called the gated tool,
      // our `allow` must have unblocked it (sentinel shows up in
      // the reply). Conditional on `permissionRequests > 0`
      // because the model can choose not to call any built-in
      // tool; in that case the permission codepath wasn't
      // exercised this run.
      if (permissionRequests > 0) {
        expect(result.text).toContain(sentinel);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("`{ decision: 'deny' }` blocks the tool without crashing the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-sdk-kit-perm-deny-"));
    const target = join(dir, "sentinel.txt");
    const sentinel = "d3n1ed-sent1nel-xyz";
    writeFileSync(target, sentinel, "utf-8");
    let permissionRequests = 0;

    try {
      await using agent = createAgent({ provider: copilot({ cwd: "/tmp" }) });
      const turn = agent.run({
        prompt: `Read the file ${target} and reply with its exact contents.`,
        options: {
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
      if (permissionRequests > 0) {
        expect(result.text).not.toContain(sentinel);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
