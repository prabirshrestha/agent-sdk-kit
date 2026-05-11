import { describe, test, expect } from "bun:test";
import {
  _createSdkDriver,
  type PiAgentSession,
  type PiSessionEvent,
} from "../../src/transports/sdk-pi.js";
import type { AgentEvent, CallOptions, StreamOp } from "../../src/types.js";

/** Construct a fake AgentSession that records subscribers and lets the test
 * push synthetic SDK events. The fake's `prompt()` returns a promise the
 * test controls via the returned `settle`/`reject` helpers. */
function makeFakeSession(opts?: {
  sessionId?: string;
  promptShouldReject?: Error;
  /** If true, prompt() never resolves — useful for testing abort/cancel. */
  promptHangs?: boolean;
}) {
  const sessionId = opts?.sessionId ?? "fake-session-uuid";
  const listeners = new Set<(ev: PiSessionEvent) => void>();
  let resolvePrompt: (() => void) | undefined;
  let rejectPrompt: ((err: Error) => void) | undefined;
  let disposed = false;
  let abortCalls = 0;
  const session: PiAgentSession = {
    sessionId,
    state: { messages: [] },
    modelRegistry: {
      registerProvider: () => {},
      find: () => undefined,
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt() {
      return new Promise<void>((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
        if (opts?.promptShouldReject) {
          reject(opts.promptShouldReject);
        }
      });
    },
    async abort() {
      abortCalls++;
    },
    dispose() {
      disposed = true;
    },
  };
  return {
    session,
    push: (ev: PiSessionEvent) => {
      for (const l of listeners) l(ev);
    },
    settlePrompt: () => resolvePrompt?.(),
    rejectPromptWith: (err: Error) => rejectPrompt?.(err),
    isDisposed: () => disposed,
    abortCalls: () => abortCalls,
    listenerCount: () => listeners.size,
  };
}

const op: StreamOp = { kind: "start", prompt: "hi" };

async function collect(
  iter: AsyncIterable<AgentEvent>,
  stopAfter?: (ev: AgentEvent) => boolean,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
    if (stopAfter?.(ev)) break;
  }
  return out;
}

describe("pi SDK driver event mapping", () => {
  test("maps text_delta into text_delta events and emits result on agent_end", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    // give microtasks a chance to register subscribe/prompt
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "message_update",
      message: { id: "m1" },
      assistantMessageEvent: { type: "text_delta", delta: "hello " },
    });
    fake.push({
      type: "message_update",
      message: { id: "m1" },
      assistantMessageEvent: { type: "text_delta", delta: "world" },
    });
    fake.push({
      type: "turn_end",
      message: { content: [{ type: "text", text: "hello world" }] },
      toolResults: [],
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();

    const events = await runP;
    const types = events.map((e) => e.type);
    expect(types).toContain("text_delta");
    expect(types).toContain("turn_end");
    const result = events.find((e) => e.type === "result") as Extract<
      AgentEvent,
      { type: "result" }
    >;
    expect(result).toBeDefined();
    expect(result.text).toBe("hello world");
    expect(result.sessionId).toBe("fake-session-uuid");
  });

  test("falls back to accumulated deltas when turn_end has no content", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "message_update",
      message: { id: "m1" },
      assistantMessageEvent: { type: "text_delta", delta: "fallback-text" },
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const events = await runP;
    const result = events.find((e) => e.type === "result") as Extract<
      AgentEvent,
      { type: "result" }
    >;
    expect(result.text).toBe("fallback-text");
  });

  test("maps tool_execution_start/end with stable callId", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "/x" },
    });
    fake.push({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "ok" }] },
      isError: false,
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const events = await runP;
    const call = events.find((e) => e.type === "tool_call") as Extract<
      AgentEvent,
      { type: "tool_call" }
    >;
    const result = events.find((e) => e.type === "tool_result") as Extract<
      AgentEvent,
      { type: "tool_result" }
    >;
    expect(call.callId).toBe("call-1");
    expect(result.callId).toBe("call-1");
    expect(result.isError).toBe(false);
    expect(result.status).toBe("completed");
  });

  test("tool_execution_end with isError surfaces failed status", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: {},
    });
    fake.push({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "boom" }] },
      isError: true,
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const events = await runP;
    const result = events.find((e) => e.type === "tool_result") as Extract<
      AgentEvent,
      { type: "tool_result" }
    >;
    expect(result.isError).toBe(true);
    expect(result.status).toBe("failed");
  });

  test("prompt() rejection surfaces error + turn_end('error') + result", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.rejectPromptWith(new Error("auth failed"));
    const events = await runP;
    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    const turnEnd = events.find((e) => e.type === "turn_end") as Extract<
      AgentEvent,
      { type: "turn_end" }
    >;
    expect(err.message).toBe("auth failed");
    expect(err.code).toBe("pi_sdk_error");
    expect(turnEnd.stopReason).toBe("error");
    expect(events.some((e) => e.type === "result")).toBe(true);
  });

  test("aborted signal surfaces turn_end('cancelled') and disposes session", async () => {
    const ac = new AbortController();
    const driver = _createSdkDriver({ abortSignal: ac.signal } as CallOptions);
    const fake = makeFakeSession({ promptHangs: true });
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    ac.abort();
    const events = await runP;
    const turnEnd = events.find((e) => e.type === "turn_end") as Extract<
      AgentEvent,
      { type: "turn_end" }
    >;
    expect(turnEnd.stopReason).toBe("cancelled");
    expect(fake.isDisposed()).toBe(true);
  });

  test("already-aborted signal is handled before any prompt event", async () => {
    const ac = new AbortController();
    ac.abort();
    const driver = _createSdkDriver({ abortSignal: ac.signal } as CallOptions);
    const fake = makeFakeSession({ promptHangs: true });
    const events = await collect(driver.run(fake.session, op));
    expect(events.some((e) => e.type === "turn_end" && e.stopReason === "cancelled")).toBe(true);
  });

  test("missing agent_end but prompt resolves still emits turn_end + result", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "message_update",
      message: { id: "m1" },
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    });
    // no agent_end — prompt just settles
    fake.settlePrompt();
    const events = await runP;
    expect(events.some((e) => e.type === "turn_end")).toBe(true);
    const result = events.find((e) => e.type === "result") as Extract<
      AgentEvent,
      { type: "result" }
    >;
    expect(result.text).toBe("partial");
  });

  test("permission_request is surfaced before tool_result (no deadlock)", async () => {
    let respondFn: ((d: "allow" | "deny") => Promise<void>) | undefined;
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();

    // Drive permission flow concurrently.
    const permP = driver.requestPermission({
      requestId: "p1",
      toolName: "myTool",
      details: { foo: "bar" },
    });

    const runP = collect(driver.run(fake.session, op), (ev) => {
      if (ev.type === "permission_request") {
        // Capture respond for later but don't block here.
        const e = ev as Extract<AgentEvent, { type: "permission_request" }>;
        respondFn = e.respond as typeof respondFn;
        return false;
      }
      return false;
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(respondFn).toBeDefined();
    await respondFn!("allow");
    const decision = await permP;
    expect(decision.allow).toBe(true);

    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    await runP;
  });

  test("onPermissionRequest 'deny' is honored", async () => {
    const driver = _createSdkDriver({
      onPermissionRequest: () => Promise.resolve({ decision: "deny", reason: "no" }),
    } as unknown as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    const decisionP = driver.requestPermission({
      requestId: "p1",
      toolName: "x",
      details: {},
    });
    await Promise.resolve();
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const decision = await decisionP;
    await runP;
    expect(decision.allow).toBe(false);
    expect(decision.reason).toBe("no");
  });

  test("turn_end usage maps to a usage event", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "turn_end",
      message: {
        usage: { input: 10, output: 20, totalTokens: 30, cost: { total: 0.0042 } },
        content: [{ type: "text", text: "" }],
      },
      toolResults: [],
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const events = await runP;
    const usage = events.find((e) => e.type === "usage") as Extract<AgentEvent, { type: "usage" }>;
    expect(usage).toBeDefined();
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(20);
  });

  test("stopReason from turn_end carries into final turn_end event", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "turn_end",
      message: { stopReason: "max_tokens", content: [{ type: "text", text: "x" }] },
      toolResults: [],
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const events = await runP;
    const turnEnd = events.find((e) => e.type === "turn_end") as Extract<
      AgentEvent,
      { type: "turn_end" }
    >;
    expect(turnEnd.stopReason).toBe("max_tokens");
  });

  test("upstream model error in turn_end is surfaced as an error event", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "turn_end",
      message: {
        stopReason: "error",
        errorMessage: "421 Misdirected Request",
        content: [],
      },
      toolResults: [],
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const events = await runP;
    const err = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }>;
    expect(err).toBeDefined();
    expect(err.message).toContain("421");
    expect(err.code).toBe("pi_sdk_model_error");
  });

  test("abort emits EXACTLY ONE turn_end(cancelled) and calls session.abort()", async () => {
    const driver = _createSdkDriver({
      abortSignal: AbortSignal.abort(),
    } as CallOptions);
    const fake = makeFakeSession({ promptHangs: true });
    const events = await collect(driver.run(fake.session, op));
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds.length).toBe(1);
    expect((turnEnds[0] as { stopReason: string }).stopReason).toBe("cancelled");
    // Allow the fire-and-forget abort/dispose to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.abortCalls()).toBe(1);
    expect(fake.isDisposed()).toBe(true);
  });

  test("abort during a turn yields a single turn_end(cancelled) (not double-emit)", async () => {
    const ctrl = new AbortController();
    const driver = _createSdkDriver({ abortSignal: ctrl.signal } as CallOptions);
    const fake = makeFakeSession({ promptHangs: true });
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    ctrl.abort();
    const events = await runP;
    const turnEnds = events.filter((e) => e.type === "turn_end");
    expect(turnEnds.length).toBe(1);
    expect((turnEnds[0] as { stopReason: string }).stopReason).toBe("cancelled");
  });

  test("pi 'aborted' stopReason is normalized to 'cancelled'", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "turn_end",
      message: { stopReason: "aborted", content: [], usage: undefined },
      toolResults: [],
    });
    fake.push({ type: "agent_end", messages: [] });
    fake.settlePrompt();
    const events = await runP;
    const te = events.find((e) => e.type === "turn_end") as { stopReason: string };
    expect(te.stopReason).toBe("cancelled");
  });

  test("agent_end before prompt() resolves: no double turn_end (race-safe)", async () => {
    const driver = _createSdkDriver({} as CallOptions);
    const fake = makeFakeSession();
    const runP = collect(driver.run(fake.session, op));
    await Promise.resolve();
    fake.push({ type: "agent_start" });
    fake.push({
      type: "turn_end",
      message: { stopReason: "end_turn", content: [{ type: "text", text: "ok" }] },
      toolResults: [],
    });
    fake.push({ type: "agent_end", messages: [] });
    // Simulate pi's delayed prompt() resolution AFTER agent_end has been delivered.
    setTimeout(() => fake.settlePrompt(), 10);
    const events = await runP;
    const turnEnds = events.filter((e) => e.type === "turn_end");
    const results = events.filter((e) => e.type === "result");
    expect(turnEnds.length).toBe(1);
    expect(results.length).toBe(1);
  });
});
