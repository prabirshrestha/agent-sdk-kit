import { describe, test, expect } from "bun:test";
import {
  withMeta,
  sessionEvent,
  turnStartEvent,
  turnEndEvent,
  textDeltaEvent,
  resultEvent,
  errorEvent,
} from "../../src/events.js";
import { createStreamResult } from "../../src/stream.js";
import type { AgentEvent } from "../../src/types.js";

describe("event factory helpers", () => {
  test("withMeta adds _meta without mutating original", () => {
    const original = { type: "text_delta", delta: "hello" } as AgentEvent;
    const enhanced = withMeta(original, { a: 1, b: "test" });

    expect(enhanced._meta).toEqual({ a: 1, b: "test" });
    expect(original._meta).toBeUndefined();
    expect(enhanced.type).toBe("text_delta");
  });

  test("withMeta preserves existing _meta keys", () => {
    const original = { type: "text_delta", delta: "hello", _meta: { x: 10 } } as AgentEvent;
    const enhanced = withMeta(original, { a: 1 });

    expect(enhanced._meta).toEqual({ x: 10, a: 1 });
  });

  test("sessionEvent returns correct structure", () => {
    const event = sessionEvent("test-session-123");
    expect(event).toEqual({ type: "session", sessionId: "test-session-123" });
  });

  test("turnStartEvent returns correct structure", () => {
    const event = turnStartEvent();
    expect(event).toEqual({ type: "turn_start" });
  });

  test("turnEndEvent returns correct structure", () => {
    const event = turnEndEvent("end_turn");
    expect(event).toEqual({ type: "turn_end", stopReason: "end_turn" });
  });

  test("textDeltaEvent returns correct structure", () => {
    const event = textDeltaEvent("hello", "msg-1");
    expect(event).toEqual({ type: "text_delta", delta: "hello", messageId: "msg-1" });
  });

  test("resultEvent returns correct structure", () => {
    const event = resultEvent("sess-1", "final text", { raw: "data" });
    expect(event).toEqual({
      type: "result",
      sessionId: "sess-1",
      text: "final text",
      raw: { raw: "data" },
    });
  });

  test("errorEvent returns correct structure", () => {
    const event = errorEvent("error message", "ERR_CODE", { detail: "data" });
    expect(event).toEqual({
      type: "error",
      message: "error message",
      code: "ERR_CODE",
      raw: { detail: "data" },
    });
  });
});

describe("createStreamResult multiplexer", () => {
  async function* createTestStream(events: AgentEvent[]): AsyncIterable<AgentEvent> {
    for (const event of events) {
      yield event;
    }
  }

  test("accumulates text_delta events into text Promise", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      turnStartEvent(),
      textDeltaEvent("Hello"),
      textDeltaEvent(" "),
      textDeltaEvent("World"),
      turnEndEvent("end_turn"),
      resultEvent("sess-1", "Hello World", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const text = await result.text;

    expect(text).toBe("Hello World");
  });

  test("resolves sessionId Promise from session event", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-123"),
      turnStartEvent(),
      textDeltaEvent("test"),
      resultEvent("sess-123", "test", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const sessionId = await result.sessionId;

    expect(sessionId).toBe("sess-123");
  });

  test("resolves sessionId even if session event arrives LATE after text_deltas", async () => {
    // Simulates the copilot quirk where session event comes after text_deltas
    const events: AgentEvent[] = [
      turnStartEvent(),
      textDeltaEvent("Hello"),
      textDeltaEvent(" World"),
      sessionEvent("sess-late"), // Session event arrives late
      resultEvent("sess-late", "Hello World", {}),
    ];

    const result = createStreamResult(createTestStream(events), "copilot");
    const sessionId = await result.sessionId;

    expect(sessionId).toBe("sess-late");
  });

  test("resolves sessionId from result event if no session event", async () => {
    const events: AgentEvent[] = [
      turnStartEvent(),
      textDeltaEvent("test"),
      resultEvent("sess-from-result", "", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const sessionId = await result.sessionId;

    expect(sessionId).toBe("sess-from-result");
  });

  test("text prefers accumulated text_delta over result.text when result.text is empty", async () => {
    // Bug fix test: some providers emit result with empty text
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      textDeltaEvent("Accumulated"),
      textDeltaEvent(" text"),
      resultEvent("sess-1", "", {}), // Empty text in result
    ];

    const result = createStreamResult(createTestStream(events), "copilot");
    const finalResult = await result.result;

    expect(finalResult.text).toBe("Accumulated text");
  });

  test("textStream async iterable yields only text deltas as strings", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      turnStartEvent(),
      textDeltaEvent("Hello"),
      textDeltaEvent(" "),
      textDeltaEvent("World"),
      turnEndEvent("end_turn"),
      resultEvent("sess-1", "Hello World", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const chunks: string[] = [];

    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["Hello", " ", "World"]);
  });

  test("fullStream yields ALL events", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      turnStartEvent(),
      textDeltaEvent("test"),
      turnEndEvent("end_turn"),
      resultEvent("sess-1", "test", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const collected: AgentEvent[] = [];

    for await (const event of result.fullStream) {
      collected.push(event);
    }

    expect(collected.length).toBe(5);
    expect(collected.map((e) => e.type)).toEqual([
      "session",
      "turn_start",
      "text_delta",
      "turn_end",
      "result",
    ]);
  });

  test("abort() cancels pending consumers cleanly", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      textDeltaEvent("Hello"),
      textDeltaEvent(" World"),
    ];

    async function* slowStream(): AsyncIterable<AgentEvent> {
      for (const event of events) {
        yield event;
        await new Promise((res) => setTimeout(res, 50));
      }
      // Should never reach here after abort
      yield resultEvent("sess-1", "Hello World", {});
    }

    const result = createStreamResult(slowStream(), "claude");
    const chunks: string[] = [];

    setTimeout(() => result.abort(), 60);

    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    // Should have collected 1-2 chunks before abort
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.length).toBeLessThan(3);
  });

  test("multiple consumers can read from same stream", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      textDeltaEvent("A"),
      textDeltaEvent("B"),
      textDeltaEvent("C"),
      resultEvent("sess-1", "ABC", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");

    // Consumer 1: read text deltas
    const textChunks: string[] = [];
    const textPromise = (async () => {
      for await (const chunk of result.textStream) {
        textChunks.push(chunk);
      }
    })();

    // Consumer 2: read full events
    const fullEvents: AgentEvent[] = [];
    const fullPromise = (async () => {
      for await (const event of result.fullStream) {
        fullEvents.push(event);
      }
    })();

    await Promise.all([textPromise, fullPromise]);

    expect(textChunks).toEqual(["A", "B", "C"]);
    expect(fullEvents.length).toBe(5);
  });

  test("handles session_forked event for sessionId resolution", async () => {
    const events: AgentEvent[] = [
      { type: "session_forked", sessionId: "sess-new", sourceSessionId: "sess-old" },
      textDeltaEvent("forked content"),
      resultEvent("sess-new", "forked content", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const sessionId = await result.sessionId;

    expect(sessionId).toBe("sess-new");
  });

  test("resolves usage from usage event", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      textDeltaEvent("test"),
      {
        type: "usage",
        inputTokens: 100,
        outputTokens: 50,
        cachedReadTokens: 20,
        costUsd: 0.01,
      },
      resultEvent("sess-1", "test", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const usage = await result.usage;

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: undefined,
      costUsd: 0.01,
    });
  });

  test("populates cacheWriteTokens on AgentUsage from cachedWriteTokens usage event", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-cw"),
      textDeltaEvent("cached"),
      {
        type: "usage",
        inputTokens: 200,
        outputTokens: 80,
        cachedReadTokens: 40,
        cachedWriteTokens: 60,
        costUsd: 0.02,
      },
      resultEvent("sess-cw", "cached", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const usage = await result.usage;

    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheWriteTokens: 60,
      costUsd: 0.02,
    });
  });

  test("resolves usage as undefined when no usage event", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      textDeltaEvent("test"),
      resultEvent("sess-1", "test", {}),
    ];

    const result = createStreamResult(createTestStream(events), "claude");
    const usage = await result.usage;

    expect(usage).toBeUndefined();
  });

  test("rejects promises on error event", async () => {
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      textDeltaEvent("test"),
      errorEvent("Something went wrong", "ERR_TEST"),
    ];

    const result = createStreamResult(createTestStream(events), "claude");

    await expect(result.result).rejects.toThrow("Something went wrong");
  });

  test("sessionId rejection surfaces upstream error message, not generic terminator", async () => {
    // No session event, only an error event — sessionId must reject with the
    // real cause, not the generic "Stream ended without a session event".
    const events: AgentEvent[] = [
      errorEvent("claude exited with code 1", "cli_exit_1", { stderr: "rate limit" }),
    ];

    const result = createStreamResult(createTestStream(events), "claude");

    // Attach rejection handler to result.result eagerly so Bun doesn't flag
    // it as unhandled while we await sessionId.
    result.result.catch(() => {});

    let caught: unknown;
    try {
      await result.sessionId;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("claude exited with code 1");
    expect((caught as Error).message).not.toContain("Stream ended without a session event");
  });

  test("handles external abort signal", async () => {
    const abortController = new AbortController();
    const events: AgentEvent[] = [
      sessionEvent("sess-1"),
      textDeltaEvent("Hello"),
      textDeltaEvent(" World"),
    ];

    async function* slowStream(): AsyncIterable<AgentEvent> {
      for (const event of events) {
        yield event;
        await new Promise((res) => setTimeout(res, 50));
      }
    }

    const result = createStreamResult(slowStream(), "claude", abortController.signal);
    const chunks: string[] = [];

    setTimeout(() => abortController.abort(), 60);

    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeLessThan(3);
  });
});
