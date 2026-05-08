// Shared helpers for end-to-end tests.
//
// Conventions:
//   - Each test file gates on `await e2eGate("<provider>")` which returns true
//     only when (a) RUN_E2E_<PROVIDER>=1 (or RUN_E2E=1 for all) AND (b) the
//     underlying CLI and/or SDK is actually present. Just having the binary
//     in PATH isn't enough — auth state isn't probed and the env opt-in keeps
//     CI honest.
//   - `runTurnWithRetry` / `consumeTurnWithRetry` retry transient
//     403/rate-limit/connection errors common to copilot-backed providers and
//     abort timed-out turns before retrying.
//   - `retryScenario` retries a whole multi-turn scenario from a fresh session
//     when a per-turn timeout leaves session state unreliable.
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

export function envFlag(name: string): boolean {
  return process.env[name] === "1" || process.env[name]?.toLowerCase() === "true";
}

/**
 * Has the user opted in to running e2e for this provider?
 *
 * Honored env vars (any one is enough):
 *   - RUN_E2E=1                          → enable all providers
 *   - RUN_E2E_<PROVIDER>=1               → enable a specific provider
 *
 * Tests that depend on multiple LLM round-trips (resume-at, multi-turn resume,
 * etc.) additionally consult `slowE2eEnabled()`, which requires RUN_E2E_SLOW=1
 * (or RUN_E2E_FULL=1). They are skipped by default to keep the baseline e2e
 * suite 100% reliable; their failure is almost always upstream rate-limiting,
 * not our code.
 */
function envOptedIn(provider: string): boolean {
  if (envFlag("RUN_E2E")) return true;
  return envFlag(`RUN_E2E_${provider.toUpperCase().replace(/-/g, "_")}`);
}

/**
 * Whether to run "slow" e2e tests that depend on multiple successful LLM
 * round-trips (resume-at, multi-turn resume). Default false — these tests
 * are rate-limit-sensitive and can hang under shared quotas.
 */
export function slowE2eEnabled(): boolean {
  return envFlag("RUN_E2E_SLOW") || envFlag("RUN_E2E_FULL");
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

type RetryableTurn = { result: Promise<unknown>; abort: (r?: unknown) => void };

function isRetryableE2eError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Forbidden") ||
    msg.includes("403") ||
    msg.includes("rate limit") ||
    msg.includes("connection") ||
    msg.includes("timed out")
  );
}

function timeoutAfter(label: string, attempt: number, perAttemptMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`${label} attempt ${attempt + 1} timed out after ${perAttemptMs}ms`)),
      perAttemptMs,
    );
  });
  return { promise, clear: () => timer && clearTimeout(timer) };
}

function abandonTurn(turn: RetryableTurn): void {
  turn.abort(new Error("retry: previous attempt abandoned"));
  turn.result.catch(() => {});
}

async function retryTurn<T extends RetryableTurn, R>(
  label: string,
  buildTurn: () => T,
  consume: (turn: T) => Promise<R>,
  retries: number,
  delayMs: number,
  perAttemptMs: number,
): Promise<R> {
  for (let i = 0; i < retries; i++) {
    const turn = buildTurn();
    const timeout = timeoutAfter(label, i, perAttemptMs);
    try {
      return await Promise.race([consume(turn), timeout.promise]);
    } catch (err: unknown) {
      abandonTurn(turn);
      if (!isRetryableE2eError(err) || i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    } finally {
      timeout.clear();
    }
  }
  throw new Error("unreachable");
}

export async function retryScenario<T>(
  fn: () => Promise<T>,
  retries = 3,
  delayMs = 2_000,
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: unknown) {
      if (!isRetryableE2eError(err) || i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

/**
 * Retry an entire `agent.run({...})` turn: builds the turn, awaits its
 * `.result`, and on per-attempt timeout calls `.abort()` so the
 * abandoned SSE stream is torn down before the next attempt. Use this for
 * resume / multi-turn tests where a single hang would otherwise leak a
 * dangling provider stream across retries.
 */
export async function runTurnWithRetry<T extends RetryableTurn>(
  buildTurn: () => T,
  retries = 2,
  delayMs = 2_000,
  perAttemptMs = 25_000,
): Promise<Awaited<T["result"]>> {
  return retryTurn(
    "runTurnWithRetry",
    buildTurn,
    (turn) => turn.result as Promise<Awaited<T["result"]>>,
    retries,
    delayMs,
    perAttemptMs,
  );
}

/**
 * Retry a turn whose body iterates `fullStream` (e.g. `collectFullStream`).
 * Builds the turn, races the consumer fn against a per-attempt timeout, and
 * aborts the turn on timeout so the abandoned SSE stream is torn down before
 * the next attempt. Returns whatever the consumer returns.
 */
export async function consumeTurnWithRetry<
  T extends RetryableTurn,
  R,
>(
  buildTurn: () => T,
  consume: (turn: T) => Promise<R>,
  retries = 2,
  delayMs = 2_000,
  perAttemptMs = 25_000,
): Promise<R> {
  return retryTurn("consumeTurnWithRetry", buildTurn, consume, retries, delayMs, perAttemptMs);
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
 * Assert §6.2 fullStream ordering invariants on the events that ARE present:
 *
 *   [session?] → turn_start → [...content events...] → [turn_end?] → result
 *
 * Notes:
 *   - `session` is only emitted by the kit on `start` ops, not on `resume`
 *     (caller already knows the sessionId). When present it must precede turn_start.
 *   - `text_delta` ordering vs turn_start is NOT enforced — some SDKs
 *     (notably opencode) stream assistant chunks ahead of turn_start. We
 *     only require text_delta to land before result.
 *   - `turn_end` is required on most transports but optional on ACP today;
 *     when present it must follow turn_start and precede result.
 */
export function assertLifecycleOrdering(
  events: Array<{ type: string }>,
  opts: LifecycleOrderingOpts = {},
): void {
  const types = events.map((e) => e.type);
  const find = (t: string) => types.indexOf(t);
  const label = opts.label ?? "lifecycle";

  const session = find("session");
  const turnStart = find("turn_start");
  const turnEnd = find("turn_end");
  const result = find("result");
  const textDelta = find("text_delta");

  expect(turnStart, `[${label}] turn_start required`).toBeGreaterThanOrEqual(0);
  expect(result, `[${label}] result must follow turn_start`).toBeGreaterThan(turnStart);

  if (session >= 0) {
    expect(session, `[${label}] session must precede turn_start`).toBeLessThan(turnStart);
  }

  if (turnEnd >= 0) {
    expect(turnEnd, `[${label}] turn_end must follow turn_start`).toBeGreaterThan(turnStart);
    expect(turnEnd, `[${label}] turn_end must precede result`).toBeLessThan(result);
  }

  if (opts.requireTextDelta) {
    expect(textDelta, `[${label}] expected at least one text_delta event`).toBeGreaterThanOrEqual(
      0,
    );
  }
  if (textDelta >= 0) {
    expect(textDelta, `[${label}] text_delta must precede result`).toBeLessThan(result);
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
