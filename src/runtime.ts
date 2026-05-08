/**
 * Small runtime helper module on top of `node:*` built-ins. Centralizes
 * subprocess spawning and port probing so call-sites get a uniform surface
 * (web ReadableStream stdout/stderr, a stable `exited: Promise<number>`,
 * `which`, `isPortFree`) instead of reimplementing the same wrapping over
 * `node:child_process` / `node:net` in every file. Runs unchanged on Node.js
 * 18+ and Bun (Bun is Node-API compatible).
 */

import { spawn as nodeSpawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as net from "node:net";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Result of `spawnProcess()`. Mirrors the subset of Bun.Subprocess that the
 * library previously relied on, so call-sites can keep using `proc.stdout`,
 * `proc.stderr`, `proc.exited`, `proc.kill()`, and `proc.pid` unchanged.
 *
 * stdout/stderr are exposed as web ReadableStreams (the same surface Bun
 * uses). We construct them with `Readable.toWeb()`; the Node implementation
 * and Bun's implementation are both compatible with `TextDecoder` +
 * `reader.read()` consumers.
 */
export interface SpawnedProcess {
  pid: number | undefined;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  /** Resolves with the process exit code when the child exits. */
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Control stdin disposition. Default: "ignore". */
  stdin?: "pipe" | "inherit" | "ignore";
  /** Control stderr disposition. Default: "pipe". */
  stderr?: "pipe" | "inherit" | "ignore";
  /** Start the process in its own process group so kill() can terminate descendants. */
  detached?: boolean;
}

/**
 * Spawn a subprocess with piped stdout (always) and configurable stdin/stderr.
 * stdin defaults to "ignore" (matching the common Bun usage in this library).
 *
 * Returns a {@link SpawnedProcess} whose shape matches the Bun.Subprocess
 * fields that the codebase uses.
 */
export function spawnProcess(cmd: string[], opts: SpawnOpts = {}): SpawnedProcess {
  const [command, ...args] = cmd;
  if (!command) {
    throw new Error("spawnProcess: empty cmd");
  }
  const stdinMode = opts.stdin ?? "ignore";
  const stderrMode = opts.stderr ?? "pipe";

  const proc = nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: [stdinMode, "pipe", stderrMode],
    detached: opts.detached,
  });

  const exited = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    proc.on("exit", (code, signal) => {
      if (typeof code === "number") {
        settle(code);
      } else if (signal) {
        // Conventional "killed by signal" mapping: 128 + signal number.
        // We don't have the numeric signal here reliably, fall back to 1.
        settle(1);
      } else {
        settle(0);
      }
    });
    proc.on("error", () => settle(1));
  });

  const stdout = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stderrStream =
    stderrMode === "pipe" && proc.stderr
      ? (Readable.toWeb(proc.stderr) as unknown as ReadableStream<Uint8Array>)
      : emptyReadableStream();

  return {
    pid: proc.pid,
    stdout,
    stderr: stderrStream,
    exited,
    kill: (signal) => {
      try {
        if (opts.detached && proc.pid) {
          process.kill(-proc.pid, signal);
          return true;
        }
        return proc.kill(signal);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Like {@link spawnProcess}, but also exposes a piped stdin as a
 * WritableStream<Uint8Array>. Used by transports that need bidirectional
 * stdio (ACP: newline-delimited JSON-RPC over stdin/stdout).
 */
export interface SpawnedProcessWithStdin extends SpawnedProcess {
  stdin: WritableStream<Uint8Array>;
}

export function spawnProcessWithStdin(
  cmd: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    stderr?: "pipe" | "inherit" | "ignore";
  } = {},
): SpawnedProcessWithStdin {
  const [command, ...args] = cmd;
  if (!command) {
    throw new Error("spawnProcessWithStdin: empty cmd");
  }
  const stderrMode = opts.stderr ?? "inherit";
  const proc = nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: ["pipe", "pipe", stderrMode],
  });

  const exited = new Promise<number>((resolve) => {
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    proc.on("exit", (code) => settle(code ?? 0));
    proc.on("error", () => settle(1));
  });

  const stdin = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
  const stdout = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stderrStream =
    stderrMode === "pipe" && proc.stderr
      ? (Readable.toWeb(proc.stderr) as unknown as ReadableStream<Uint8Array>)
      : emptyReadableStream();

  return {
    pid: proc.pid,
    stdin,
    stdout,
    stderr: stderrStream,
    exited,
    kill: (signal) => {
      try {
        return proc.kill(signal);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Try to bind `port` on `host`. Returns true if the port was free (bind
 * succeeded and was released cleanly), false on EADDRINUSE or any other
 * listen error. Used by copilot-api managed-mode to fail fast before
 * spawning the daemon.
 */
export async function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    let settled = false;
    const settle = (free: boolean) => {
      if (settled) return;
      settled = true;
      resolve(free);
    };
    server.once("error", () => settle(false));
    server.once("listening", () => {
      server.close(() => settle(true));
    });
    try {
      server.listen(port, host);
    } catch {
      settle(false);
    }
  });
}

/**
 * Node-portable replacement for `Bun.which(name)`. Walks the PATH and, on
 * Windows, tries each PATHEXT extension. Returns the absolute path to the
 * executable or null if not found. We use `fs.stat` rather than `fs.access`
 * with X_OK because X_OK is not meaningful on Windows and we still want
 * cross-platform behaviour.
 */
export async function which(binary: string): Promise<string | null> {
  const PATH = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  // If the binary already contains a path separator, don't search PATH.
  if (binary.includes("/") || binary.includes("\\")) {
    try {
      const stat = await fs.stat(binary);
      if (stat.isFile()) return binary;
    } catch {
      /* not found */
    }
    return null;
  }
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, binary + ext);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile()) return full;
      } catch {
        /* noexist — keep searching */
      }
    }
  }
  return null;
}

function emptyReadableStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}
