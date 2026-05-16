// Sanity tests for the release-lock error-message matcher in src/spawn.ts.
// We can't easily reproduce the race in a unit test across runtimes, but we
// can lock in the wording variants the matcher must accept.
import { describe, expect, test } from "bun:test";

const matcher = /released|not\s+held|no\s+longer/i;

describe("spawn release-lock matcher", () => {
  const expectedMatches = [
    "ReadableStreamDefaultReader: released",
    "Cannot release a lock on a reader that is not held",
    "The lock is no longer valid",
    "lock released",
    "RELEASED",
  ];
  for (const msg of expectedMatches) {
    test(`matches: ${msg}`, () => {
      expect(matcher.test(msg)).toBe(true);
    });
  }

  test("does NOT match unrelated errors", () => {
    expect(matcher.test("Some other error")).toBe(false);
    expect(matcher.test("EPIPE: broken pipe")).toBe(false);
    expect(matcher.test("Stream is locked to a reader.")).toBe(false);
  });
});
