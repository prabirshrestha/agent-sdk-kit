/**
 * Unit tests for `redactSecrets` helper. The function is used at CLI stderr
 * surfacing sites to avoid leaking tokens / API keys into user-facing error
 * events that might be logged downstream.
 */
import { describe, test, expect } from "bun:test";
import { redactSecrets } from "../../src/errors.js";

describe("redactSecrets", () => {
  test("redacts env-var style ANTHROPIC_AUTH_TOKEN with sk- value", () => {
    const input = "ANTHROPIC_AUTH_TOKEN=sk-abc123 something";
    const out = redactSecrets(input);
    expect(out).toBe("ANTHROPIC_AUTH_TOKEN=[REDACTED] something");
    expect(out).not.toContain("sk-abc123");
  });

  test("redacts GITHUB_TOKEN env-var value", () => {
    const input = "GITHUB_TOKEN=ghp_xxxxxxxx";
    const out = redactSecrets(input);
    expect(out).toBe("GITHUB_TOKEN=[REDACTED]");
    expect(out).not.toContain("ghp_xxxxxxxx");
  });

  test("redacts Authorization: Bearer header", () => {
    const input = "Authorization: Bearer sk-1234";
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-1234");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts sk- prefix tokens in the middle of text", () => {
    const input = "error: key sk-abcdef12345 is invalid";
    const out = redactSecrets(input);
    expect(out).toBe("error: key [REDACTED] is invalid");
    expect(out).not.toContain("sk-abcdef12345");
  });

  test("empty string is unchanged", () => {
    expect(redactSecrets("")).toBe("");
  });

  test("undefined-ish (falsy) input is returned unchanged", () => {
    // redactSecrets guards on truthiness; callers often pass `"" | undefined`.
    // Using `as unknown as string` to exercise the falsy short-circuit.
    const undef = undefined as unknown as string;
    expect(redactSecrets(undef)).toBe(undef);
  });

  test("string with no secrets is unchanged", () => {
    const input = "copilot exited with code 1: unable to reach server";
    expect(redactSecrets(input)).toBe(input);
  });

  test("redacts github_pat_ prefixed personal access tokens", () => {
    const input = "token=github_pat_abcDEF123_456";
    const out = redactSecrets(input);
    expect(out).not.toContain("github_pat_abcDEF123_456");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts anthropic- prefixed keys", () => {
    const input = "using key anthropic-admin-01-xyz today";
    const out = redactSecrets(input);
    expect(out).not.toContain("anthropic-admin-01-xyz");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts bare Bearer token without Authorization prefix", () => {
    const input = "sent Bearer abcDEF.1234-5678 to upstream";
    const out = redactSecrets(input);
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain("abcDEF.1234-5678");
  });

  test("redacts multiple tokens across multi-line (LF) input", () => {
    const input = "line1 sk-abc\nline2\nline3 ghp_xyz";
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-abc");
    expect(out).not.toContain("ghp_xyz");
    // Newlines preserved so callers can still render a multi-line message.
    expect(out.split("\n").length).toBe(3);
    expect(out).toContain("[REDACTED]");
    // Both tokens redacted on their respective lines.
    expect(out.split("\n")[0]).toContain("[REDACTED]");
    expect(out.split("\n")[2]).toContain("[REDACTED]");
  });

  test("redacts tokens across CRLF line endings", () => {
    const input = "a sk-xxx\r\nb Authorization: Bearer zzz";
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-xxx");
    expect(out).not.toContain("zzz");
    expect(out).toContain("[REDACTED]");
    // CRLF preserved — the redactor must not collapse line terminators.
    expect(out).toContain("\r\n");
  });

  test("redacts JSON-embedded token without breaking parseability", () => {
    const input = '{"key":"sk-abcdef12345","other":"fine"}';
    const out = redactSecrets(input);
    expect(out).not.toContain("sk-abcdef12345");
    expect(out).toContain("[REDACTED]");
    // Output must still parse as JSON with the redaction as the value.
    const parsed = JSON.parse(out) as { key: string; other: string };
    expect(parsed.key).toBe("[REDACTED]");
    expect(parsed.other).toBe("fine");
  });
});
