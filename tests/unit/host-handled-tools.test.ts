// Regression test for the host-handled tool contract.
//
// `AgentTool.execute` is optional (src/types.ts). Hosts can register a
// tool by schema only — the kit emits the resulting `tool_call` on the
// agent stream and the host acts post-turn. Transports MUST NOT crash
// with `tool.execute is not a function` in this case; instead they
// synthesize a neutral ack via `synthesizeHostHandledResult` so the
// SDK's tool-result loop completes and the agent's turn proceeds.
//
// Before this fix, hanger's planner role tools (task_create,
// task_prompt_write) — which ship without execute — would crash the
// Copilot SDK mid-turn after the agent called them.

import { describe, expect, test } from "bun:test";
import { isHostHandledTool, synthesizeHostHandledResult } from "../../src/tools.js";
import type { AgentTool } from "../../src/types.js";

describe("host-handled tool helpers", () => {
  test("synthesizeHostHandledResult: returns { ok: true, input }", () => {
    expect(synthesizeHostHandledResult({ title: "foo" })).toEqual({
      ok: true,
      input: { title: "foo" },
    });
    expect(synthesizeHostHandledResult(undefined)).toEqual({
      ok: true,
      input: undefined,
    });
  });

  test("isHostHandledTool: true when execute is absent", () => {
    const hostHandled: AgentTool = {
      name: "task_create",
      description: "host-handled",
      inputSchema: { type: "object" },
    };
    expect(isHostHandledTool(hostHandled)).toBe(true);
  });

  test("isHostHandledTool: false when execute is a function", () => {
    const real: AgentTool = {
      name: "ping",
      description: "real",
      inputSchema: { type: "object" },
      execute: async () => ({ pong: true }),
    };
    expect(isHostHandledTool(real)).toBe(false);
  });

  test("isHostHandledTool: true when execute is not a function (defensive)", () => {
    // Hosts may produce an AgentTool literal with a non-function
    // `execute` by mistake (e.g. via type widening). The predicate
    // catches that too and routes the call through the synthesized
    // ack path instead of crashing the agent's turn.
    const bogus = {
      name: "x",
      description: "x",
      inputSchema: {},
      execute: "not a function" as unknown as undefined,
    } as AgentTool;
    expect(isHostHandledTool(bogus)).toBe(true);
  });
});
