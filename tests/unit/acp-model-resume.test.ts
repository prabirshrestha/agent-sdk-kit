import { describe, expect, test } from "bun:test";
import { decideAcpModelOverride } from "../../src/transports/acp.ts";

describe("decideAcpModelOverride", () => {
  test("no override → skip", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: undefined,
        hasSessionId: true,
        capability: true,
        opKind: "start",
        explicitPerCall: false,
      }),
    ).toBe("skip");
  });

  test("no sessionId → skip", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: "gpt-5",
        hasSessionId: false,
        capability: true,
        opKind: "start",
        explicitPerCall: true,
      }),
    ).toBe("skip");
  });

  test("capability=false → unsupported", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: "gpt-5",
        hasSessionId: true,
        capability: false,
        opKind: "start",
        explicitPerCall: true,
      }),
    ).toBe("unsupported");
  });

  test("start + capability=true → apply", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: "gpt-5",
        hasSessionId: true,
        capability: true,
        opKind: "start",
        explicitPerCall: true,
      }),
    ).toBe("apply");
  });

  // Regression: this is the original bug.
  test("resume + unknown capability + non-explicit (defaultModel only) → skip", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: "gpt-5",
        hasSessionId: true,
        capability: undefined,
        opKind: "resume",
        explicitPerCall: false,
      }),
    ).toBe("skip");
  });

  test("resume + unknown capability + explicit per-call → apply", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: "claude-sonnet-4-5",
        hasSessionId: true,
        capability: undefined,
        opKind: "resume",
        explicitPerCall: true,
      }),
    ).toBe("apply");
  });

  test("resume + known capability=true → apply", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: "gpt-5",
        hasSessionId: true,
        capability: true,
        opKind: "resume",
        explicitPerCall: false,
      }),
    ).toBe("apply");
  });

  test("start + unknown capability + non-explicit → apply (no soft-skip for new sessions)", () => {
    expect(
      decideAcpModelOverride({
        modelOverride: "gpt-5",
        hasSessionId: true,
        capability: undefined,
        opKind: "start",
        explicitPerCall: false,
      }),
    ).toBe("apply");
  });
});
