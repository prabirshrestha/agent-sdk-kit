/**
 * Regression tests for path-traversal hardening in provider deleteSession
 * implementations. Claude and Copilot both interpolate `sessionId` into a
 * filesystem path, so any value that is not a canonical UUID must be rejected
 * with AgentError { kind: "invalid_input", code: "invalid_session_id" }.
 */
import { describe, test, expect } from "bun:test";
import { claude } from "../../src/providers/claude.js";
import { AgentError, assertValidSessionId } from "../../src/errors.js";

const INVALID_INPUTS: Array<{ label: string; value: string }> = [
  { label: "parent traversal", value: "../../" },
  { label: "nested parent traversal", value: "../../etc/passwd" },
  { label: "absolute path", value: "/etc/passwd" },
  { label: "empty string", value: "" },
  { label: "arbitrary string", value: "not-a-uuid" },
  { label: "uuid with trailing slash", value: "12345678-1234-1234-1234-123456789012/" },
  { label: "uuid with path suffix", value: "12345678-1234-1234-1234-123456789012/../x" },
  { label: "whitespace", value: "   " },
  { label: "uuid with null byte", value: "12345678-1234-1234-1234-123456789012\0" },
];

const VALID_UUID_LOWER = "12345678-1234-1234-1234-123456789012";
const VALID_UUID_UPPER = "ABCDEF12-ABCD-ABCD-ABCD-ABCDEF123456";

function expectInvalidSessionId(err: unknown) {
  expect(err).toBeInstanceOf(AgentError);
  const ae = err as AgentError;
  expect(ae.kind).toBe("invalid_input");
  expect(ae.code).toBe("invalid_session_id");
}

describe("assertValidSessionId", () => {
  for (const { label, value } of INVALID_INPUTS) {
    test(`rejects ${label}`, () => {
      try {
        assertValidSessionId(value);
        throw new Error("expected AgentError");
      } catch (err) {
        expectInvalidSessionId(err);
      }
    });
  }

  test("rejects non-string input", () => {
    try {
      // deliberately pass a non-string to exercise the typeof guard
      assertValidSessionId(1234 as unknown as string);
      throw new Error("expected AgentError");
    } catch (err) {
      expectInvalidSessionId(err);
    }
  });

  test("accepts lowercase UUID", () => {
    expect(() => assertValidSessionId(VALID_UUID_LOWER)).not.toThrow();
  });

  test("accepts uppercase UUID", () => {
    expect(() => assertValidSessionId(VALID_UUID_UPPER)).not.toThrow();
  });
});

describe("claude.deleteSession sessionId validation", () => {
  const provider = claude({ cwd: "/tmp/agent-sdk-test-claude" });

  for (const { label, value } of INVALID_INPUTS) {
    test(`rejects ${label}`, async () => {
      try {
        await provider.deleteSession!(value);
        throw new Error("expected AgentError");
      } catch (err) {
        expectInvalidSessionId(err);
      }
    });
  }
});
