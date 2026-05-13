import { describe, test, expect } from "bun:test";
import { tool } from "../../src/tools.js";

const ctx = () => ({
  sessionId: "s-1",
  abortSignal: new AbortController().signal,
});

describe("tool() async generator support", () => {
  test("plain Promise return — unchanged", async () => {
    const t = tool("echo", {
      description: "echo",
      inputSchema: { type: "object" },
      execute: async (input) => ({ echoed: input }),
    });
    const out = await t.execute!({ hello: "world" }, ctx());
    expect(out).toEqual({ echoed: { hello: "world" } });
  });

  test("sync value return — unchanged", async () => {
    const t = tool("ping", {
      description: "ping",
      inputSchema: { type: "object" },
      execute: () => ({ ok: true }),
    });
    const out = await t.execute!({}, ctx());
    expect(out).toEqual({ ok: true });
  });

  test("async generator — last yielded value is the result", async () => {
    const t = tool("stream", {
      description: "streaming tool",
      inputSchema: { type: "object" },
      execute: async function* () {
        yield { state: "loading" };
        yield { state: "processing" };
        yield { state: "done", result: 42 };
      },
    });
    const out = await t.execute!({}, ctx());
    expect(out).toEqual({ state: "done", result: 42 });
  });

  test("async generator — intermediate yields forwarded via ctx.emit", async () => {
    const emitted: unknown[] = [];
    const t = tool("progress", {
      description: "progress tool",
      inputSchema: { type: "object" },
      execute: async function* () {
        yield { step: 1 };
        yield { step: 2 };
        yield { step: 3, final: true };
      },
    });
    const out = await t.execute!(
      {},
      {
        sessionId: "s-1",
        abortSignal: new AbortController().signal,
        emit: (v) => emitted.push(v),
      },
    );
    expect(out).toEqual({ step: 3, final: true });
    expect(emitted).toEqual([{ step: 1 }, { step: 2 }]);
  });

  test("async generator with no emit hook — progress silently dropped, final still returned", async () => {
    const t = tool("silent", {
      description: "no-emit",
      inputSchema: { type: "object" },
      execute: async function* () {
        yield { progress: "hidden" };
        yield { result: "visible" };
      },
    });
    const out = await t.execute!({}, ctx());
    expect(out).toEqual({ result: "visible" });
  });

  test("async generator that throws — error wrapped as isError:true", async () => {
    const t = tool("bad", {
      description: "throws",
      inputSchema: { type: "object" },
      execute: async function* () {
        yield { state: "starting" };
        throw new Error("boom");
      },
    });
    const out = await t.execute!({}, ctx());
    expect(out).toEqual({ isError: true, message: "boom" });
  });

  test("empty async generator — returns undefined", async () => {
    const t = tool("empty", {
      description: "empty",
      inputSchema: { type: "object" },
      execute: async function* () {
        // yields nothing
      },
    });
    const out = await t.execute!({}, ctx());
    expect(out).toBeUndefined();
  });

  test("transport-style emit binding — captures callId+name per update", async () => {
    // Simulates the sdk-copilot wiring: the transport binds emit to the
    // invocation's callId + tool name and forwards each update to a
    // normalized tool_progress event sink.
    const sink: Array<{ callId: string; name: string; update: unknown }> = [];
    const emitToolProgress = (callId: string, name: string, update: unknown) => {
      sink.push({ callId, name, update });
    };

    const t = tool("bound", {
      description: "bound emit",
      inputSchema: { type: "object" },
      execute: async function* () {
        yield { pct: 10 };
        yield { pct: 50 };
        yield { pct: 100, done: true };
      },
    });

    const callId = "tc-42";
    const out = await t.execute!(
      {},
      {
        sessionId: "s-1",
        abortSignal: new AbortController().signal,
        emit: (update) => emitToolProgress(callId, t.name, update),
      },
    );

    expect(out).toEqual({ pct: 100, done: true });
    expect(sink).toEqual([
      { callId: "tc-42", name: "bound", update: { pct: 10 } },
      { callId: "tc-42", name: "bound", update: { pct: 50 } },
    ]);
  });
});
