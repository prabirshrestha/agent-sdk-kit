// Shared helpers for end-to-end tests.
//
// Conventions:
//   - Each test file gates on `await e2eGate("<provider>")` which returns true
//     only when (a) RUN_E2E_<PROVIDER>=1 (or RUN_E2E=1 for all) AND (b) the
//     underlying CLI and/or SDK is actually present. Just having the binary
//     in PATH isn't enough — auth state isn't probed and the env opt-in keeps
//     CI honest.
//   - `withRetry` retries transient 403/rate-limit/connection errors common
//     to copilot-backed providers.
//   - `assertLifecycleOrdering` enforces the §6.2 event ordering invariant
//     used by every transport.
//
// This file MUST NOT depend on any provider transport so importing it never
// has side-effects.

import { expect } from "bun:test";
import type { ProviderName } from "../../src/types.js";
import { isProviderAvailable } from "../../src/index.js";

/* ------------------------------------------------------------------ */
/* Env gating                                                          */
/* ------------------------------------------------------------------ */

const E2E_GATES: ReadonlyArray<{ name: ProviderName | "copilot-sdk" | "opencode-sdk" }> = [
  { name: "claude" },
  { name: "copilot" },
  { name: "copilot-sdk" },
  { name: "opencode" },
  { name: "opencode-sdk" },
  { name: "pi" },
  { name: "acp" },
];

function envFlag(name: string): boolean {
  return process.env[name] === "1" || process.env[name]?.toLowerCase() === "true";
}

/** Has the user opted in to running e2e for this provider? */
function envOptedIn(provider: string): boolean {
  if (envFlag("RUN_E2E")) return true;
  return envFlag(`RUN_E2E_${provider.toUpperCase().replace(/-/g, "_")}`);
}

/**
 * Returns true if e2e tests for `provider` should run: env opt-in AND the
 * underlying CLI/SDK is installed.
 *
 * - "claude" | "copilot" | "opencode" | "pi": probes the CLI via --version
 * - "copilot-sdk" | "opencode-sdk": probes that the SDK package can be imported
 * - "acp": probes that *some* ACP-capable CLI (default: copilot --acp) exists
 */
export async function e2eGate(
  provider: "claude" | "copilot" | "opencode" | "pi" | "acp" | "copilot-sdk" | "opencode-sdk",
): Promise<boolean> {
  if (!envOptedIn(provider)) return false;

  switch (provider) {
    case "claude":
    case "copilot":
    case "opencode":
    case "pi":
      return await isProviderAvailable(provider).catch(() => false);
    case "acp":
      // ACP transport spawns whatever the test wires; default fixture uses
      // `copilot --acp`, so gate on copilot CLI presence.
      return await isProviderAvailable("copilot").catch(() => false);
    case "copilot-sdk":
      try {
        await import("@github/copilot-sdk");
        return true;
      } catch {
        return false;
      }
    case "opencode-sdk":
      try {
        await import("@opencode-ai/sdk");
        return true;
      } catch {
        return false;
      }
  }
}

/** Print a one-line skip notice on the first miss per provider, for clarity. */
const _logged = new Set<string>();
export function logSkip(provider: string, reason: string): void {
  if (_logged.has(provider)) return;
  _logged.add(provider);
  console.log(`[e2e] skipping ${provider}: ${reason}`);
}

/* ------------------------------------------------------------------ */
/* Retry                                                                */
/* ------------------------------------------------------------------ */

/** Retry transient 403 / rate-limit / spawn failures (copilot-backed APIs). */
export async function withRetry<T>(fn: () => Promise<T>, retries = 5, delayMs = 8_000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        msg.includes("Forbidden") ||
        msg.includes("403") ||
        msg.includes("rate limit") ||
        msg.includes("connection");
      if (!retryable || i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

/* ------------------------------------------------------------------ */
/* fullStream assertions                                               */
/* ------------------------------------------------------------------ */

export interface LifecycleOrderingOpts {
  /** Require text_delta events to be present (default: false — some prompts return one chunk via text_block). */
  requireTextDelta?: boolean;
  /** Provider name for clearer assertion messages. */
  label?: string;
}

/**
 * Assert §6.2 fullStream ordering invariants:
 *   session → turn_start → ... → turn_end → result
 *
 * Use this in every basic / resume / model-override e2e to make sure the
 * matrix's "fullStream" promise actually holds across all transports.
 */
export function assertLifecycleOrdering(
  events: Array<{ type: string }>,
  opts: LifecycleOrderingOpts = {},
): void {
  const types = events.map((e) => e.type);
  const find = (t: string) => types.indexOf(t);

  const session = find("session");
  const turnStart = find("turn_start");
  const turnEnd = find("turn_end");
  const result = find("result");
  const textDelta = find("text_delta");

  expect(session, `[${opts.label ?? "lifecycle"}] expected a session event`).toBeGreaterThanOrEqual(
    0,
  );
  expect(
    turnStart,
    `[${opts.label ?? "lifecycle"}] turn_start must follow session`,
  ).toBeGreaterThan(session);
  expect(turnEnd, `[${opts.label ?? "lifecycle"}] turn_end must follow turn_start`).toBeGreaterThan(
    turnStart,
  );
  expect(result, `[${opts.label ?? "lifecycle"}] result must follow turn_end`).toBeGreaterThan(
    turnEnd,
  );

  if (opts.requireTextDelta) {
    expect(
      textDelta,
      `[${opts.label ?? "lifecycle"}] expected at least one text_delta event`,
    ).toBeGreaterThan(turnStart);
    expect(textDelta).toBeLessThan(turnEnd);
  } else if (textDelta >= 0) {
    expect(textDelta).toBeGreaterThan(turnStart);
    expect(textDelta).toBeLessThan(turnEnd);
  }
}

/** Drain a turn into a list of fullStream events. */
export async function collectFullStream(turn: {
  fullStream: AsyncIterable<{ type: string }>;
  result: Promise<unknown>;
}): Promise<Array<{ type: string }>> {
  turn.result.catch(() => {}); // suppress unhandled rejection during iteration
  const events: Array<{ type: string }> = [];
  for await (const ev of turn.fullStream) events.push(ev);
  await turn.result; // surface errors
  return events;
}

// Touch the registry to satisfy the unused-export linter when no test uses it.
export const _registeredGates = E2E_GATES.map((g) => g.name);
