// Regression test for the PermissionDecision → Copilot SDK shape
// translation. The kit's public callback signature is
// `(req) => PermissionDecision` where PermissionDecision is
// `{ decision: "allow" | "deny" }`, but the @github/copilot-sdk
// PermissionHandler expects `{ kind: "approve-once" | "reject" | ... }`.
// Before this fix the Copilot transport handed the user's return value
// straight to the SDK, which crashed with "unexpected user permission
// response". This test pins the translation so the kit's documented
// contract keeps working — and also confirms that callers who already
// speak SDK-native pass through unchanged.

import { describe, expect, test } from "bun:test";
import { translatePermissionDecision } from "../../src/transports/sdk-copilot.ts";

describe("translatePermissionDecision", () => {
  test("{ decision: 'allow' } → { kind: 'approve-once' }", () => {
    expect(translatePermissionDecision({ decision: "allow" })).toEqual({
      kind: "approve-once",
    });
  });

  test("{ decision: 'deny' } → { kind: 'reject' }", () => {
    expect(translatePermissionDecision({ decision: "deny" })).toEqual({
      kind: "reject",
    });
  });

  test("{ decision: 'deny', reason } maps reason → feedback", () => {
    expect(translatePermissionDecision({ decision: "deny", reason: "nope" })).toEqual({
      kind: "reject",
      feedback: "nope",
    });
  });

  test("native SDK shape passes through unchanged", () => {
    const native = { kind: "approve-once" } as const;
    expect(translatePermissionDecision(native)).toBe(native);
  });

  test("native reject with feedback passes through", () => {
    const native = { kind: "reject", feedback: "not safe" } as const;
    expect(translatePermissionDecision(native)).toBe(native);
  });

  test("garbage input → reject (defensive)", () => {
    expect(translatePermissionDecision(null)).toEqual({ kind: "reject" });
    expect(translatePermissionDecision(undefined)).toEqual({ kind: "reject" });
    expect(translatePermissionDecision("yes")).toEqual({ kind: "reject" });
    expect(translatePermissionDecision(42)).toEqual({ kind: "reject" });
  });
});
