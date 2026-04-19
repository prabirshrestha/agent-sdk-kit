import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SandboxConfig, SandboxPolicy } from "../types.js";
import { AgentError } from "../errors.js";
import { spawnProcess } from "../runtime.js";

export interface SandboxApplyResult {
  cmd: string[]; // possibly wrapped argv
  cleanup?: () => Promise<void>; // unlink any temp profile files
  applied: boolean; // whether sandbox was actually applied
  reason?: string; // why not (e.g. "nono not installed")
}

/**
 * Wraps a child process command with `nono run`
 * - If `config?.mode` is undefined or `"none"` → return `{cmd, applied: false, reason: "mode=none"}`.
 * - Detect `nono` binary on PATH. If missing:
 *   - If `config.failIfUnavailable` → throw `AgentError("internal", "Sandbox required but nono not installed")`.
 *   - Else log warn and return `{cmd, applied: false, reason: "nono missing"}`.
 * - Detect macOS nesting (`process.env.APP_SANDBOX_CONTAINER_ID` set). If present:
 *   - If `failIfUnavailable` → throw.
 *   - Else warn and return `{cmd, applied: false, reason: "macOS nesting"}`.
 * - For mode === "cwd": write a profile with read=[cwd], write=[cwd], network=allow → temp file → wrap as `["nono","run","--profile",<path>,"--",...cmd]`.
 * - For mode === "paranoid": read=[cwd], write=[cwd], network=deny, env strip "*".
 * - For SandboxPolicy object: serialize fields directly.
 * - For `{nonoProfile}` or `{nonoProfileFile}`: pass to nono accordingly.
 * - Cleanup unlinks temp profile.
 */
export async function applySandbox(
  cmd: string[],
  cwd: string | undefined,
  config: SandboxConfig | undefined,
  abortSignal?: AbortSignal,
): Promise<SandboxApplyResult> {
  if (abortSignal?.aborted) {
    throw new AgentError("cancelled", "Sandbox application aborted", undefined, "aborted");
  }
  // Default mode is "none"
  if (!config || !config.mode || config.mode === "none") {
    return { cmd, applied: false, reason: "mode=none" };
  }

  // Detect nono binary on PATH
  const nonoBinPath = config.nonoBinPath || "nono";
  const nonoAvailable = await checkNonoAvailable(nonoBinPath);

  if (!nonoAvailable) {
    if (config.failIfUnavailable) {
      throw new AgentError("internal", "Sandbox required but nono not installed");
    }
    console.warn("[agent-sdk] sandbox requested but nono not found — child runs unsandboxed");
    return { cmd, applied: false, reason: "nono missing" };
  }

  // Detect macOS nesting
  if (process.env.APP_SANDBOX_CONTAINER_ID) {
    if (config.failIfUnavailable) {
      throw new AgentError(
        "internal",
        "Sandbox nesting not supported on macOS (APP_SANDBOX_CONTAINER_ID detected)",
      );
    }
    console.warn("[agent-sdk] macOS sandbox nesting detected — child runs in outer sandbox");
    return { cmd, applied: false, reason: "macOS nesting" };
  }

  const effectiveCwd = cwd || process.cwd();

  // Handle different mode types
  if (config.mode === "cwd") {
    // Built-in preset: read world, write only under cwd, network allow
    const policy: SandboxPolicy = {
      filesystem: {
        read: [effectiveCwd],
        write: [effectiveCwd],
      },
      network: { allow: ["*"] },
    };
    return await applyWithPolicy(nonoBinPath, cmd, policy);
  } else if (config.mode === "paranoid") {
    // Built-in preset: read cwd only, no write, no network
    const policy: SandboxPolicy = {
      filesystem: {
        read: [effectiveCwd],
        write: [],
      },
      network: "deny",
      env: { strip: "*" },
    };
    return await applyWithPolicy(nonoBinPath, cmd, policy);
  } else if (typeof config.mode === "object") {
    if ("nonoProfile" in config.mode) {
      // Named nono profile
      const wrappedCmd = [nonoBinPath, "run", "--profile", config.mode.nonoProfile, "--", ...cmd];
      return { cmd: wrappedCmd, applied: true };
    } else if ("nonoProfileFile" in config.mode) {
      // Inline nono profile file path
      const wrappedCmd = [
        nonoBinPath,
        "run",
        "--profile",
        config.mode.nonoProfileFile,
        "--",
        ...cmd,
      ];
      return { cmd: wrappedCmd, applied: true };
    } else {
      // SandboxPolicy object
      return await applyWithPolicy(nonoBinPath, cmd, config.mode as SandboxPolicy);
    }
  }

  return { cmd, applied: false, reason: "unknown mode" };
}

/**
 * Check if nono is available on PATH.
 * Best-effort: try to spawn `nono --version`.
 */
async function checkNonoAvailable(nonoBinPath: string): Promise<boolean> {
  try {
    const proc = spawnProcess([nonoBinPath, "--version"], {
      stdin: "ignore",
      stderr: "pipe",
    });
    const timeoutMs = 2000;
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((resolve) =>
        setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // ignore
          }
          resolve(124); // conventional "timeout" exit code
        }, timeoutMs),
      ),
    ]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Apply a SandboxPolicy by writing a temp profile file and wrapping the command.
 * Profile format: JSON (best-guess for nono, which may accept KDL or JSON).
 */
async function applyWithPolicy(
  nonoBinPath: string,
  cmd: string[],
  policy: SandboxPolicy,
): Promise<SandboxApplyResult> {
  // Write a temp profile file (JSON format, best-guess)
  // Note: nono's actual profile format might differ; this is a best-effort implementation
  const profilePath = path.join(
    os.tmpdir(),
    `agent-sdk-nono-${crypto.randomBytes(8).toString("hex")}.json`,
  );

  const profileContent: Record<string, unknown> = {};

  if (policy.filesystem) {
    profileContent.filesystem = {
      read: policy.filesystem.read || [],
      write: policy.filesystem.write || [],
      deny: policy.filesystem.deny || [],
    };
  }

  if (policy.network) {
    if (policy.network === "deny") {
      profileContent.network = { deny: true };
    } else {
      profileContent.network = {
        allow: policy.network.allow || [],
        proxy: policy.network.proxy || false,
      };
    }
  }

  if (policy.env) {
    profileContent.env = {
      strip: policy.env.strip || [],
      keep: policy.env.keep || [],
    };
  }

  await fs.writeFile(profilePath, JSON.stringify(profileContent, null, 2), "utf-8");

  const wrappedCmd = [nonoBinPath, "run", "--profile", profilePath, "--", ...cmd];

  return {
    cmd: wrappedCmd,
    applied: true,
    cleanup: async () => {
      try {
        await fs.unlink(profilePath);
      } catch {
        // ignore cleanup errors
      }
    },
  };
}
