import { describe, expect, test } from "bun:test";
import { createNormalizeState, normalizeEvent } from "../../src/transports/sdk-copilot.ts";

// Cast to satisfy the SDK SessionEvent type — the runtime only reads
// `type` and `data` so this is safe for the test.
const ev = (type: string, data: unknown) =>
  ({ type, data }) as unknown as Parameters<typeof normalizeEvent>[0];

describe("sdk-copilot normalizeEvent text dedup", () => {
  test("synthesizes deltas when SDK only emits assistant.message", () => {
    const state = createNormalizeState();
    const out = normalizeEvent(
      ev("assistant.message", { content: "hello world", messageId: "m1" }),
      state,
    );
    const deltas = out.filter((e) => e.type === "text_delta");
    const final = out.filter((e) => e.type === "assistant_message");
    expect(final).toHaveLength(1);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((d: any) => d.delta).join("")).toBe("hello world");
  });

  test("does NOT synthesize deltas when message_delta already streamed for the same messageId", () => {
    const state = createNormalizeState();
    const deltaEvents = normalizeEvent(
      ev("assistant.message_delta", { deltaContent: "hello", messageId: "m1" }),
      state,
    );
    expect(deltaEvents.filter((e) => e.type === "text_delta")).toHaveLength(1);

    const messageEvents = normalizeEvent(
      ev("assistant.message", { content: "hello world", messageId: "m1" }),
      state,
    );

    const synthesized = messageEvents.filter((e) => e.type === "text_delta");
    const finalMsg = messageEvents.filter((e) => e.type === "assistant_message");
    expect(synthesized).toHaveLength(0);
    expect(finalMsg).toHaveLength(1);
    expect((finalMsg[0] as any).text).toBe("hello world");
  });

  test("separate messageIds are tracked independently", () => {
    const state = createNormalizeState();
    normalizeEvent(ev("assistant.message_delta", { deltaContent: "abc", messageId: "m1" }), state);
    const m2 = normalizeEvent(
      ev("assistant.message", { content: "fresh message", messageId: "m2" }),
      state,
    );
    expect(m2.filter((e) => e.type === "text_delta").length).toBeGreaterThan(0);
  });

  test("works without state (backward compatible) — still synthesizes", () => {
    const out = normalizeEvent(ev("assistant.message", { content: "hi", messageId: "m1" }));
    expect(out.filter((e) => e.type === "text_delta").length).toBeGreaterThan(0);
  });

  test("no messageId still synthesizes (no way to dedupe)", () => {
    const state = createNormalizeState();
    const out = normalizeEvent(ev("assistant.message", { content: "hi" }), state);
    expect(out.filter((e) => e.type === "text_delta").length).toBeGreaterThan(0);
  });
});
