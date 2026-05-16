// Unit test for the queue+waker streaming pattern used in
// src/transports/acp.ts. The actual ACP transport is hard to unit-test in
// isolation (it instantiates a JSON-RPC client over child-process stdio), so
// this test reproduces the exact wiring inline and proves the semantic
// invariant we care about:
//
//   Events pushed asynchronously while an `await` is in flight MUST be
//   delivered to the async iterator BEFORE the awaited operation resolves —
//   not buffered and flushed afterwards.
//
// Previously, ACP buffered every session/update event into a local array and
// only drained after `agentClient.prompt(...)` resolved. That made streaming
// non-streaming. The fix is the same pattern reproduced here.

import { describe, expect, test } from "bun:test";

interface QueueAndWaker<T> {
  push(item: T): void;
  iterate(donePromise: Promise<void>): AsyncIterable<T>;
}

function makeStream<T>(): QueueAndWaker<T> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  return {
    push(item) {
      queue.push(item);
      notify();
    },
    async *iterate(donePromise) {
      let done = false;
      donePromise.finally(() => {
        done = true;
        notify();
      });
      let idx = 0;
      while (true) {
        while (idx < queue.length) yield queue[idx++]!;
        if (done && idx >= queue.length) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

describe("acp streaming queue+waker", () => {
  test("events pushed during an in-flight await are yielded before completion", async () => {
    const stream = makeStream<string>();

    // Simulate `agentClient.prompt()` taking some time, with session/update
    // events arriving while it's in flight.
    const promptPromise = (async () => {
      await new Promise((r) => setTimeout(r, 5));
      stream.push("delta-1");
      await new Promise((r) => setTimeout(r, 5));
      stream.push("delta-2");
      await new Promise((r) => setTimeout(r, 5));
      stream.push("delta-3");
      await new Promise((r) => setTimeout(r, 5));
    })();

    const observed: { item: string; promptDone: boolean }[] = [];
    let promptDone = false;
    promptPromise.then(() => {
      promptDone = true;
    });

    for await (const item of stream.iterate(promptPromise)) {
      observed.push({ item, promptDone });
    }

    expect(observed.map((o) => o.item)).toEqual(["delta-1", "delta-2", "delta-3"]);
    // The critical invariant: every delta is delivered BEFORE the prompt
    // promise resolves. Previously they were all buffered and emitted after.
    for (const o of observed) {
      expect(o.promptDone).toBe(false);
    }
  });

  test("events pushed after completion are still drained", async () => {
    const stream = makeStream<string>();
    const donePromise = (async () => {
      stream.push("a");
      stream.push("b");
    })();

    const out: string[] = [];
    for await (const item of stream.iterate(donePromise)) {
      out.push(item);
    }
    expect(out).toEqual(["a", "b"]);
  });

  test("empty stream completes cleanly", async () => {
    const stream = makeStream<string>();
    const donePromise = Promise.resolve();
    const out: string[] = [];
    for await (const item of stream.iterate(donePromise)) {
      out.push(item);
    }
    expect(out).toEqual([]);
  });
});
