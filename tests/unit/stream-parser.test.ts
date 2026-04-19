import { describe, test, expect } from "bun:test";
import { parseJsonlStream } from "../../src/spawn.js";

describe("parseJsonlStream", () => {
  test("splits buffered chunks into lines correctly when chunks contain partial lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split a JSON line across multiple chunks
        controller.enqueue(encoder.encode('{"a":1}\n{"b"'));
        controller.enqueue(encoder.encode(':2}\n{"c":3'));
        controller.enqueue(encoder.encode("}\n"));
        controller.close();
      },
    });

    const results: unknown[] = [];
    for await (const obj of parseJsonlStream(stream)) {
      results.push(obj);
    }

    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("handles multi-byte UTF-8 characters split across chunks", async () => {
    const encoder = new TextEncoder();
    const robotEmoji = "🤖"; // 4 bytes in UTF-8: F0 9F A4 96
    const robotBytes = encoder.encode(robotEmoji);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split emoji across chunks within a JSON string
        const jsonStart = encoder.encode('{"emoji":"');
        const jsonEnd = encoder.encode('"}\n');

        controller.enqueue(jsonStart);
        // Split the 4-byte emoji: first 2 bytes
        controller.enqueue(robotBytes.slice(0, 2));
        // Remaining 2 bytes
        controller.enqueue(robotBytes.slice(2));
        controller.enqueue(jsonEnd);
        controller.close();
      },
    });

    const results: unknown[] = [];
    for await (const obj of parseJsonlStream(stream)) {
      results.push(obj);
    }

    expect(results).toEqual([{ emoji: "🤖" }]);
  });

  test("skips empty lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n\n\n{"b":2}\n  \n{"c":3}\n'));
        controller.close();
      },
    });

    const results: unknown[] = [];
    for await (const obj of parseJsonlStream(stream)) {
      results.push(obj);
    }

    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("skips non-JSON lines with warning", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n'));
        controller.enqueue(encoder.encode("not valid json\n"));
        controller.enqueue(encoder.encode('{"b":2}\n'));
        controller.close();
      },
    });

    // Suppress console.warn for this test
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    try {
      const results: unknown[] = [];
      for await (const obj of parseJsonlStream(stream)) {
        results.push(obj);
      }

      expect(results).toEqual([{ a: 1 }, { b: 2 }]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("Non-JSON line");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("yields trailing data without final newline", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n{"b":2}'));
        controller.close();
      },
    });

    const results: unknown[] = [];
    for await (const obj of parseJsonlStream(stream)) {
      results.push(obj);
    }

    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("stops yielding when abortSignal aborts mid-stream", async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n'));
        await new Promise((res) => setTimeout(res, 10));
        controller.enqueue(encoder.encode('{"b":2}\n'));
        await new Promise((res) => setTimeout(res, 10));
        controller.enqueue(encoder.encode('{"c":3}\n'));
        controller.close();
      },
    });

    const results: unknown[] = [];
    let count = 0;

    for await (const obj of parseJsonlStream(stream, abortController.signal)) {
      results.push(obj);
      count++;
      if (count === 1) {
        abortController.abort();
      }
    }

    // Should only get the first result before abort
    expect(results.length).toBeLessThanOrEqual(2);
    expect(results[0]).toEqual({ a: 1 });
  });

  test("handles abort before stream starts", async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    abortController.abort();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"a":1}\n'));
        controller.close();
      },
    });

    const results: unknown[] = [];
    for await (const obj of parseJsonlStream(stream, abortController.signal)) {
      results.push(obj);
    }

    expect(results).toEqual([]);
  });
});
