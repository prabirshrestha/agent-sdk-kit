import { describe, test, expect } from "bun:test";
import { tool } from "../../src/tools.js";
import type { AgentEvent, ToolContext } from "../../src/index.js";

function baseCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "s-1",
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

/**
 * Helper: build a ctx.emit that captures emitted values, and return a handle
 * that lets the test drive a respond("allow"|"deny") against the first
 * permission_request it sees.
 */
function makeEmitWithResponder(decision: "allow" | "deny") {
  const emitted: unknown[] = [];
  let responded = false;
  const emit = (update: unknown) => {
    emitted.push(update);
    const ev = update as AgentEvent & { respond?: (d: "allow" | "deny") => Promise<void> };
    if (!responded && ev.type === "permission_request" && typeof ev.respond === "function") {
      responded = true;
      // Fire and forget — the gate listener resolves synchronously once respond() runs.
      void ev.respond(decision);
    }
  };
  return { emit, emitted };
}

describe("tool() approval gate", () => {
  test("needsApproval: false → execute called directly, no permission_request emitted", async () => {
    const emitted: unknown[] = [];
    let executed = false;
    const t = tool("safe", {
      description: "safe op",
      inputSchema: { type: "object" },
      needsApproval: false,
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });
    const out = await t.execute({}, baseCtx({ emit: (v) => emitted.push(v) }));
    expect(out).toEqual({ ok: true });
    expect(executed).toBe(true);
    expect(emitted.find((e) => (e as AgentEvent).type === "permission_request")).toBeUndefined();
  });

  test("needsApproval: true + emit defined + respond(allow) → permission_request emitted, execute runs", async () => {
    const { emit, emitted } = makeEmitWithResponder("allow");
    let executed = false;
    const t = tool("gated", {
      description: "gated op",
      inputSchema: { type: "object" },
      needsApproval: true,
      execute: async () => {
        executed = true;
        return { value: 42 };
      },
    });
    const out = await t.execute({ arg: "x" }, baseCtx({ emit }));
    expect(executed).toBe(true);
    expect(out).toEqual({ value: 42 });
    const req = emitted.find(
      (e) => (e as AgentEvent).type === "permission_request",
    ) as AgentEvent & { toolName: string; details: unknown; requestId: string };
    expect(req).toBeDefined();
    expect(req.toolName).toBe("gated");
    expect(req.details).toEqual({ arg: "x" });
    expect(typeof req.requestId).toBe("string");
    expect(req.requestId.length).toBeGreaterThan(0);
  });

  test("needsApproval: true + respond(deny) → execute NOT called, returns denial object", async () => {
    const { emit, emitted } = makeEmitWithResponder("deny");
    let executed = false;
    const t = tool("gated-deny", {
      description: "gated op",
      inputSchema: { type: "object" },
      needsApproval: true,
      execute: async () => {
        executed = true;
        return { value: "should-not-run" };
      },
    });
    const out = await t.execute({}, baseCtx({ emit }));
    expect(executed).toBe(false);
    expect(out).toEqual({ isError: true, message: "denied by user approval gate" });
    expect(emitted.some((e) => (e as AgentEvent).type === "permission_request")).toBe(true);
  });

  test("needsApproval: predicate(input) returning true gates; false skips", async () => {
    // Predicate returns true for { sensitive: true }, false otherwise.
    const def = {
      description: "conditional gate",
      inputSchema: { type: "object" },
      needsApproval: (input: unknown) => Boolean((input as { sensitive?: boolean }).sensitive),
      execute: async (input: unknown) => ({ received: input }),
    };

    // Case A: predicate returns true → gate fires, respond(allow) → executes.
    {
      const { emit, emitted } = makeEmitWithResponder("allow");
      const t = tool("cond", def);
      const out = await t.execute({ sensitive: true }, baseCtx({ emit }));
      expect(out).toEqual({ received: { sensitive: true } });
      expect(emitted.some((e) => (e as AgentEvent).type === "permission_request")).toBe(true);
    }

    // Case B: predicate returns false → gate does NOT fire; no emit.
    {
      const emitted: unknown[] = [];
      const t = tool("cond", def);
      const out = await t.execute({ sensitive: false }, baseCtx({ emit: (v) => emitted.push(v) }));
      expect(out).toEqual({ received: { sensitive: false } });
      expect(emitted.find((e) => (e as AgentEvent).type === "permission_request")).toBeUndefined();
    }
  });

  test("needsApproval: true + emit undefined → fallback, execute called directly", async () => {
    let executed = false;
    const t = tool("gated-no-emit", {
      description: "gated op",
      inputSchema: { type: "object" },
      needsApproval: true,
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });
    // No emit on ctx — gate must silently skip.
    const out = await t.execute({}, baseCtx());
    expect(executed).toBe(true);
    expect(out).toEqual({ ok: true });
  });

  test("needsApproval: async predicate returning true is awaited and gates correctly", async () => {
    // Async predicate: returns true for input.foo === "bar", else false.
    const def = {
      description: "async gate",
      inputSchema: { type: "object" },
      needsApproval: async (input: unknown) => (input as { foo?: string }).foo === "bar",
      execute: async (input: unknown) => ({ received: input }),
    };

    // Case A: async predicate resolves true → gate fires, respond(allow) → executes.
    {
      const { emit, emitted } = makeEmitWithResponder("allow");
      const t = tool("async-cond", def);
      const out = await t.execute({ foo: "bar" }, baseCtx({ emit }));
      expect(out).toEqual({ received: { foo: "bar" } });
      const req = emitted.find(
        (e) => (e as AgentEvent).type === "permission_request",
      ) as AgentEvent & { toolName: string; details: unknown };
      expect(req).toBeDefined();
      expect(req.toolName).toBe("async-cond");
      expect(req.details).toEqual({ foo: "bar" });
    }

    // Case B: async predicate resolves false → gate skipped; no emit.
    {
      const emitted: unknown[] = [];
      const t = tool("async-cond", def);
      const out = await t.execute({ foo: "baz" }, baseCtx({ emit: (v) => emitted.push(v) }));
      expect(out).toEqual({ received: { foo: "baz" } });
      expect(emitted.find((e) => (e as AgentEvent).type === "permission_request")).toBeUndefined();
    }

    // Case C: async predicate resolves true → gate fires, respond(deny) → execute NOT called.
    {
      const { emit, emitted } = makeEmitWithResponder("deny");
      let executed = false;
      const t = tool("async-cond-deny", {
        description: "async gate deny",
        inputSchema: { type: "object" },
        needsApproval: async (input: unknown) => (input as { foo?: string }).foo === "bar",
        execute: async () => {
          executed = true;
          return { should: "not-run" };
        },
      });
      const out = await t.execute({ foo: "bar" }, baseCtx({ emit }));
      expect(executed).toBe(false);
      expect(out).toEqual({ isError: true, message: "denied by user approval gate" });
      expect(emitted.some((e) => (e as AgentEvent).type === "permission_request")).toBe(true);
    }
  });

  test("needsApproval: async predicate that throws is caught by tool wrapper and surfaced as { isError }", async () => {
    // Document actual behavior: the tool() wrapper has a catch-all try/catch
    // that converts any thrown error (sync predicate, async predicate, or
    // execute()) into `{ isError: true, message }`. The error does NOT
    // propagate out of wrappedExecute — it is surfaced as a structured
    // failure to the caller.
    const emitted: unknown[] = [];
    let executed = false;
    const t = tool("async-throw", {
      description: "async throwing predicate",
      inputSchema: { type: "object" },
      needsApproval: async (_input: unknown) => {
        throw new Error("predicate blew up");
      },
      execute: async () => {
        executed = true;
        return { ok: true };
      },
    });
    const out = await t.execute({}, baseCtx({ emit: (v) => emitted.push(v) }));
    // Actual behavior: tool() wrapper swallows the throw into an isError result.
    expect(out).toEqual({ isError: true, message: "predicate blew up" });
    expect(executed).toBe(false);
    // No permission_request was emitted because the predicate threw before
    // we reached the emit() call.
    expect(emitted.find((e) => (e as AgentEvent).type === "permission_request")).toBeUndefined();
  });

  test("needsApproval is forwarded on the returned AgentTool", () => {
    const t = tool("forwarded", {
      description: "x",
      inputSchema: { type: "object" },
      needsApproval: true,
      execute: async () => ({}),
    });
    expect(t.needsApproval).toBe(true);

    const t2 = tool("forwarded-none", {
      description: "y",
      inputSchema: { type: "object" },
      execute: async () => ({}),
    });
    expect(t2.needsApproval).toBeUndefined();
  });
});
