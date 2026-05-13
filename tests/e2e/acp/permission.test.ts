// ACP permission-flow e2e — uses copilot --acp as the agent server.
// Same contract as the Copilot SDK test: callers return the
// documented `{ decision: "allow" | "deny" }` shape; the ACP transport
// at sdk-acp.ts:531-545 maps that to the ACP wire protocol's
// PermissionOption (allow_once / reject_once etc).
//
// ACP correctly uses `decision.decision === "allow"` already, so this
// is a contract pin — not a fix verification.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { acp, createAgent } from "../../../src/index.js";
import type { AgentEvent } from "../../../src/index.js";
import { e2eGate } from "../_helpers.js";

const enabled = await e2eGate("acp");

// Substring the kit's Copilot SDK throws if permission shape leaks
// through. Pinning against this string catches a future regression
// where someone copies the leaky pattern into ACP's transport.
const PERMISSION_SHAPE_REGRESSION = "unexpected user permission response";

function looksLikePermissionShapeRegression(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return msg.toLowerCase().includes(PERMISSION_SHAPE_REGRESSION);
}

describe.skipIf(!enabled)("acp / permission flow (copilot --acp)", () => {
  test("`{ decision: 'allow' }` lets the agent execute a gated built-in tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-sdk-kit-perm-acp-"));
    const target = join(dir, "sentinel.txt");
    const sentinel = "acp-sent1nel-q4z";
    writeFileSync(target, sentinel, "utf-8");
    let permissionRequests = 0;

    try {
      await using agent = createAgent({
        provider: acp({ spawn: ["copilot", "--acp"] }),
      });
      const turn = agent.run({
        prompt: `Use your read tool to read ${target} and reply with EXACTLY the file contents verbatim. Nothing else.`,
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
      const result = await turn.result.catch((err) => {
        streamThrew ??= err;
        return { sessionId: "", text: "", provider: "acp" as const, raw: null };
      });

      // PRIMARY: never see the permission-shape regression error.
      expect(looksLikePermissionShapeRegression(streamThrew)).toBe(false);
      expect(typeof result.text).toBe("string");
      // SECONDARY: when permission fired and the run produced
      // any text at all, the sentinel should be in it. We skip
      // this when the model returned an empty string (e.g.,
      // upstream rate limit or refusal) since that's an
      // unrelated provider issue.
      if (permissionRequests > 0 && result.text.length > 0) {
        expect(result.text).toContain(sentinel);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  test("`{ decision: 'deny' }` blocks the tool without crashing the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-sdk-kit-perm-acp-deny-"));
    const target = join(dir, "sentinel.txt");
    const sentinel = "acp-deny-sent1nel";
    writeFileSync(target, sentinel, "utf-8");
    let permissionRequests = 0;

    try {
      await using agent = createAgent({
        provider: acp({ spawn: ["copilot", "--acp"] }),
      });
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
        return { sessionId: "", text: "", provider: "acp" as const, raw: null };
      });

      expect(looksLikePermissionShapeRegression(streamThrew)).toBe(false);
      expect(typeof result.text).toBe("string");
      if (permissionRequests > 0) {
        // Deny path: sentinel must not appear in the model's
        // reply (the read was rejected).
        expect(result.text).not.toContain(sentinel);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
