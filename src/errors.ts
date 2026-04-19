export type AgentErrorKind =
  | "auth"
  | "rate_limit"
  | "not_supported"
  | "invalid_input"
  | "timeout"
  | "cancelled"
  | "mcp"
  | "subagent"
  | "provider"
  | "internal"
  | "transport"
  // Preserved for backward compatibility with existing call sites.
  | "not_found"
  | "aborted"
  | "network";

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly raw?: unknown;
  readonly details?: unknown;
  readonly code?: string;
  readonly cause?: unknown;

  constructor(
    kind: AgentErrorKind,
    message: string,
    details?: unknown,
    code?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "AgentError";
    this.kind = kind;
    this.details = details;
    // `raw` retained as alias of `details` for backward compatibility.
    this.raw = details;
    this.code = code;
    this.cause = cause;
  }
}

export function notSupported(
  message: string,
  code = "not_supported",
  details?: unknown,
): AgentError {
  return new AgentError("not_supported", message, details, code);
}

/**
 * Redact common secret patterns from a string. Used when surfacing CLI stderr
 * to avoid leaking API keys / tokens into user-facing error messages that
 * might be logged.
 *
 * Patterns redacted:
 *   - env-var-style: `SOMETHING_TOKEN=xxx`, `SOMETHING_API_KEY=xxx`
 *   - Bearer tokens: `Bearer xxxxx`, `Authorization: xxx`
 *   - Common provider key prefixes: sk-*, ghp_*, github_pat_*, anthropic- keys
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return (
    input
      // Env-var patterns: TOKEN/KEY/SECRET/PASS in var name
      .replace(
        /\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*)=(\S+)/g,
        "$1=[REDACTED]",
      )
      // Authorization headers
      .replace(/(Authorization:?\s+)(Bearer\s+)?(\S+)/gi, "$1[REDACTED]")
      .replace(/Bearer\s+([A-Za-z0-9._\-/+=]+)/g, "Bearer [REDACTED]")
      // Common key prefixes
      .replace(/\b(sk-[A-Za-z0-9_-]+)/g, "[REDACTED]")
      .replace(/\b(ghp_[A-Za-z0-9]+)/g, "[REDACTED]")
      .replace(/\b(github_pat_[A-Za-z0-9_]+)/g, "[REDACTED]")
      .replace(/\b(anthropic-[A-Za-z0-9_-]+)/g, "[REDACTED]")
  );
}

/**
 * UUID regex for validating provider session identifiers.
 * Matches canonical 8-4-4-4-12 hex UUIDs (case-insensitive).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assert that `sessionId` is a valid UUID before it is interpolated into a
 * filesystem path. This guards against path traversal attacks (e.g. `../../`)
 * in provider `deleteSession` implementations that unlink session files on
 * disk.
 *
 * Throws `AgentError { kind: "invalid_input", code: "invalid_session_id" }`
 * when the input is empty, not a string, or does not match the canonical
 * UUID format used by Claude / Copilot session stores.
 */
export function assertValidSessionId(sessionId: unknown): asserts sessionId is string {
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
    throw new AgentError(
      "invalid_input",
      "sessionId must be a UUID",
      undefined,
      "invalid_session_id",
    );
  }
}
