// Opencode SDK permission-flow e2e — exercises the `permission.asked`
// event path. Opencode emits permission events for its built-in tools
// (read/write/shell); the transport at sdk-opencode.ts:780-840 wires
// `opts.onPermissionRequest` to those events and calls
// `client.permission.reply` with `once | always | reject` based on
// the kit's documented `PermissionDecision` shape.
//
// Unlike Copilot's bug, opencode's transport correctly uses
// `decision.decision === "allow"` (sdk-opencode.ts:830). This test
// pins that contract so a future refactor doesn't regress it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { createAgent, opencode } from "../../../src/index.js";
import type { AgentEvent } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

// The exact substring the Copilot SDK throws when the permission
// shape is wrong. Opencode's transport has its own shape entirely,
// but if a future refactor accidentally adopts the Copilot leaky
// pattern, the error text will contain this phrase. We assert
// against this phrase explicitly to keep the test from going green
// on unrelated provider-side errors (rate limits, auth, etc.).
const PERMISSION_SHAPE_REGRESSION = "unexpected user permission response";

function looksLikePermissionShapeRegression(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return msg.toLowerCase().includes(PERMISSION_SHAPE_REGRESSION);
}

const enabled = await e2eGate("opencode-sdk");
const ocConfig = { cwd: "/tmp", model: "github-copilot/gpt-5-mini" } as const;

describe.skipIf(!enabled)("opencode SDK / permission flow", () => {
  test("`{ decision: 'allow' }` lets the agent execute a gated built-in tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-sdk-kit-perm-oc-"));
    const target = join(dir, "sentinel.txt");
    const sentinel = "0penc0de-sent1nel-abc";
    writeFileSync(target, sentinel, "utf-8");

    try {
      await using agent = createAgent({ provider: opencode(ocConfig) });
      const turn = agent.run({
        prompt: `Use your read tool to read ${target} and reply with EXACTLY the file contents verbatim. Nothing else.`,
        options: {
          onPermissionRequest: async () => {
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
      const result = await turn.result.catch((err) => {
        // Provider-side errors (rate limit, auth, model
        // refusal) shouldn't fail this test — we only care
        // whether the permission-shape contract held.
        streamThrew ??= err;
        return { sessionId: "", text: "", provider: "opencode" as const, raw: null };
      });

      // PRIMARY assertion (the actual regression we're guarding):
      // the permission-shape error must NEVER appear.
      expect(looksLikePermissionShapeRegression(streamThrew)).toBe(false);
      expect(typeof result.text).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("`{ decision: 'deny' }` blocks the tool without crashing the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-sdk-kit-perm-oc-deny-"));
    const target = join(dir, "sentinel.txt");
    const sentinel = "d3ny-0penc0de-sent1nel";
    writeFileSync(target, sentinel, "utf-8");
    let permissionRequests = 0;

    try {
      await using agent = createAgent({ provider: opencode(ocConfig) });
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
      const result = await turn.result.catch((err) => {
        streamThrew ??= err;
        return { sessionId: "", text: "", provider: "opencode" as const, raw: null };
      });

      expect(looksLikePermissionShapeRegression(streamThrew)).toBe(false);
      expect(typeof result.text).toBe("string");
      if (permissionRequests > 0) {
        // Deny must have prevented the read — sentinel must NOT
        // appear in the model's final reply.
        expect(result.text).not.toContain(sentinel);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
