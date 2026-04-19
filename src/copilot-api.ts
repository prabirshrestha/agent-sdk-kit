import { AgentError } from "./errors.js";
import { spawnProcess, isPortFree as runtimeIsPortFree } from "./runtime.js";

export interface CopilotApiDaemonConfig {
  baseUrl?: string;
  daemon?: "auto" | "reuse" | "managed";
  startCommand?: string[];
  port?: number;
}

export interface CopilotApiHandle {
  baseUrl: string;
  authToken: string;
  ownsProcess: boolean;
  dispose: () => Promise<void>;
}

// Module-level cache for the resolved handle and any in-flight creation
// promise. This serializes concurrent ensureCopilotApi() callers so they do
// not race to spawn duplicate daemons against the same port.
let resolvedHandle: CopilotApiHandle | null = null;
let pendingPromise: Promise<CopilotApiHandle> | null = null;

/**
 * Ensure copilot-api daemon is running
 * - Default daemon mode: "auto", baseUrl: "http://localhost:4141"
 * - "auto": probe `${baseUrl}/v1/models` (GET, 2s timeout). If 200 → reuse: ownsProcess=false. Else spawn.
 * - "reuse": probe; if down throw AgentError("transport", …, code "daemon_unavailable").
 * - "managed": always spawn.
 * - Spawn command default: `["copilot-api"]` (or config.startCommand). Detached subprocess. Wait for ready (poll up to 30s).
 * - Auth token: "dummy" (copilot-api accepts any auth value).
 * - Return handle with dispose() that kills process if owned.
 *
 * Concurrent callers share a single in-flight creation promise; once resolved,
 * the same handle is returned for subsequent calls. On failure, the pending
 * slot is cleared so a retry can try again.
 */
export async function ensureCopilotApi(config: CopilotApiDaemonConfig): Promise<CopilotApiHandle> {
  // Fast path: already resolved — return the cached handle.
  if (resolvedHandle) return resolvedHandle;

  // Coalesce: if another caller is mid-spawn, await their result.
  if (pendingPromise) return pendingPromise;

  pendingPromise = (async (): Promise<CopilotApiHandle> => {
    const handle = await createCopilotApiHandle(config);
    resolvedHandle = handle;
    // Wrap dispose so resetting a disposed daemon also clears our cache;
    // otherwise the next ensureCopilotApi() would hand back a dead handle.
    const originalDispose = handle.dispose;
    handle.dispose = async () => {
      try {
        await originalDispose();
      } finally {
        if (resolvedHandle === handle) {
          resolvedHandle = null;
          pendingPromise = null;
        }
      }
    };
    return handle;
  })().catch((err) => {
    // On failure, clear the pending slot so the next caller can retry.
    pendingPromise = null;
    throw err;
  });

  return pendingPromise;
}

/**
 * Reset the module-level cache. Exposed for tests; in production the cache
 * lifecycle is tied to the daemon process lifetime (cleared on dispose).
 */
export function __resetCopilotApiCacheForTests(): void {
  resolvedHandle = null;
  pendingPromise = null;
}

async function createCopilotApiHandle(config: CopilotApiDaemonConfig): Promise<CopilotApiHandle> {
  const baseUrl = config.baseUrl || "http://localhost:4141";
  const daemon = config.daemon || "auto";
  const resolvedPort = config.port || Number(new URL(baseUrl).port || "4141");
  const port = resolvedPort;
  const startCommand = config.startCommand || [
    "npx",
    "-y",
    "copilot-api@latest",
    "start",
    "--port",
    String(resolvedPort),
  ];

  const authToken = "dummy";

  const isRunning = await probeDaemon(baseUrl);

  if (daemon === "reuse") {
    if (!isRunning) {
      throw new AgentError(
        "transport",
        "copilot-api daemon not running and daemon=reuse. Hint: ensure copilot-api is installed and running (e.g. `copilot-api start --port <port>`).",
        undefined,
        "daemon_unavailable",
      );
    }
    return {
      baseUrl,
      authToken,
      ownsProcess: false,
      dispose: async () => {
        // No-op: we don't own the process
      },
    };
  }

  if (daemon === "auto") {
    if (isRunning) {
      return {
        baseUrl,
        authToken,
        ownsProcess: false,
        dispose: async () => {
          // No-op: we don't own the process
        },
      };
    }
    // Fall through to spawn
  }

  // daemon === "managed": fail fast if port is already in use.
  if (daemon === "managed") {
    const free = await isPortFree(port);
    if (!free) {
      throw new AgentError("transport", `copilot-api port already in use in managed mode: ${port}`);
    }
  }

  // daemon === "managed" or (daemon === "auto" && !isRunning): spawn our own
  const proc = await spawnDaemon(startCommand, port);

  const ready = await waitForReady(baseUrl, 30);
  if (!ready) {
    proc.kill();
    await proc.exited.catch(() => {});
    throw new AgentError("internal", "copilot-api daemon failed to start within 30s");
  }

  return {
    baseUrl,
    authToken,
    ownsProcess: true,
    dispose: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

/**
 * Probe `${baseUrl}/v1/models` with a short timeout (500ms).
 * Returns true if 200 OK, false otherwise.
 */
async function probeDaemon(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Attempt to bind the port to check availability. Delegates to the Node-
 * portable `isPortFree()` from runtime.ts, which uses `net.createServer()`.
 */
async function isPortFree(port: number): Promise<boolean> {
  return runtimeIsPortFree(port);
}

/**
 * Spawn the copilot-api daemon as a subprocess. The child will be killed
 * automatically when the parent exits (Node's default spawn behavior).
 */
async function spawnDaemon(
  startCommand: string[],
  _port: number,
): Promise<{ kill: () => void; exited: Promise<number> }> {
  const proc = spawnProcess(startCommand, {
    stdin: "ignore",
    stderr: "pipe",
  });

  return {
    kill: () => {
      proc.kill();
    },
    exited: proc.exited,
  };
}

/**
 * Wait for the daemon to be ready by polling `${baseUrl}/v1/models`.
 * Polls every 500ms for up to `timeoutSec` seconds.
 */
async function waitForReady(baseUrl: string, timeoutSec: number): Promise<boolean> {
  const endTime = Date.now() + timeoutSec * 1000;

  while (Date.now() < endTime) {
    const ready = await probeDaemon(baseUrl);
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return false;
}
