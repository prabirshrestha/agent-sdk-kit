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
 * Wraps a child process command with `nono run` (see https://nono.sh).
 *
 * Behavior:
 * - If `config?.mode` is undefined or `"none"` → return `{cmd, applied: false}`.
 * - Detect `nono` binary on PATH. If missing:
 *   - If `config.failIfUnavailable` → throw `AgentError("internal", …)`.
 *   - Else warn and return the original cmd unwrapped.
 * - Detect macOS sandbox nesting (`APP_SANDBOX_CONTAINER_ID`); same fall-back.
 *
 * Mode → nono CLI mapping:
 * - `"cwd"`: `nono run --allow <cwd> -- <cmd>` (read+write under cwd, net allowed).
 * - `"paranoid"`: `nono run --read <cwd> --block-net -- <cmd>` (read-only cwd, no net).
 * - `{ nonoProfile: "<name>" }`: `nono run --profile <name> -- <cmd>`. The
 *   profile must be a built-in or live in `~/.config/nono/profiles/<name>.json`.
 * - `{ nonoProfileFile: "<path>" }`: same as above but the kit installs the file
 *   into `~/.config/nono/profiles/` under a random name and unlinks it via
 *   the returned `cleanup`. (`nono --profile` does not accept arbitrary file
 *   paths, so this indirection is required.)
 * - `SandboxPolicy` object: translated to flag form
 *   (`--read`, `--write`, `--allow`, `--allow-file`, `--read-file`,
 *    `--write-file`, `--block-net`, `--allow-domain`).
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
    // Built-in preset: read+write under cwd, network allowed.
    const wrappedCmd = [nonoBinPath, "run", "--allow", effectiveCwd, "--", ...cmd];
    return { cmd: wrappedCmd, applied: true };
  } else if (config.mode === "paranoid") {
    // Built-in preset: read-only cwd, no network.
    const wrappedCmd = [nonoBinPath, "run", "--read", effectiveCwd, "--block-net", "--", ...cmd];
    return { cmd: wrappedCmd, applied: true };
  } else if (typeof config.mode === "object") {
    if ("nonoProfile" in config.mode) {
      // Built-in or user-installed profile name.
      const wrappedCmd = [nonoBinPath, "run", "--profile", config.mode.nonoProfile, "--", ...cmd];
      return { cmd: wrappedCmd, applied: true };
    } else if ("nonoProfileFile" in config.mode) {
      // `nono --profile` only accepts a name resolved from
      // `~/.config/nono/profiles/`, never an arbitrary path. Install the file
      // there under a unique name, reference it by name, and unlink on cleanup.
      return await installProfileFile(nonoBinPath, cmd, config.mode.nonoProfileFile);
    } else {
      // SandboxPolicy object → flag-based invocation.
      return applyWithPolicy(nonoBinPath, cmd, config.mode as SandboxPolicy, effectiveCwd);
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
 * Translate a {@link SandboxPolicy} to nono CLI flags.
 *
 * Mapping (per https://nono.sh/docs/cli/usage/flags):
 * - `filesystem.read[]` → repeated `--read <dir>` (or `--read-file <file>` if it
 *   looks like a single file path with an extension).
 * - `filesystem.write[]` → repeated `--write <dir>` / `--write-file`.
 * - `filesystem.allow[]` (read+write) — there is no first-class field today,
 *   but a path appearing in BOTH `read` and `write` is collapsed to `--allow`.
 * - `filesystem.deny[]` → currently has no CLI flag (deny is profile-only);
 *   warn once and ignore. Use `{ nonoProfileFile }` for deny rules.
 * - `network === "deny"` → `--block-net`.
 * - `network.allow[]` → repeated `--allow-domain <host>` (with `--block-net`
 *   implied by the proxy filter; nono treats `--allow-domain` as a host
 *   allow-list applied through its outbound proxy).
 * - `env.strip` / `env.keep` → no CLI flag exists; warn once and ignore.
 *   Use a profile file for env scrubbing.
 */
function applyWithPolicy(
  nonoBinPath: string,
  cmd: string[],
  policy: SandboxPolicy,
  effectiveCwd: string,
): SandboxApplyResult {
  const flags: string[] = [];

  if (policy.filesystem) {
    const read = policy.filesystem.read ?? [];
    const write = policy.filesystem.write ?? [];
    const both = new Set(read.filter((p) => write.includes(p)));

    for (const p of both) {
      flags.push(...pickPathFlag("--allow", "--allow-file", p));
    }
    for (const p of read) {
      if (both.has(p)) continue;
      flags.push(...pickPathFlag("--read", "--read-file", p));
    }
    for (const p of write) {
      if (both.has(p)) continue;
      flags.push(...pickPathFlag("--write", "--write-file", p));
    }

    if (policy.filesystem.deny && policy.filesystem.deny.length > 0) {
      console.warn(
        "[agent-sdk] sandbox policy.filesystem.deny is not expressible as a nono CLI flag; " +
          "ignored. Use { nonoProfileFile } with policy.add_deny_access for deny rules.",
      );
    }
  }

  if (policy.network) {
    if (policy.network === "deny") {
      flags.push("--block-net");
    } else {
      // Host allow-list: nono routes through its outbound proxy and only
      // permits listed domains. Wildcards ("*") mean "no restriction"; in that
      // case we don't emit any --allow-domain flags (network is allowed by
      // default).
      const hosts = (policy.network.allow ?? []).filter((h) => h !== "*");
      for (const h of hosts) {
        flags.push("--allow-domain", h);
      }
    }
  }

  if (policy.env && (policy.env.strip || policy.env.keep)) {
    console.warn(
      "[agent-sdk] sandbox policy.env is not expressible as a nono CLI flag; ignored. " +
        "Use { nonoProfileFile } for environment scrubbing.",
    );
  }

  // If the policy yielded zero flags, fall back to a minimal cwd grant so the
  // child can at least access its working directory.
  if (flags.length === 0) {
    flags.push("--allow", effectiveCwd);
  }

  const wrappedCmd = [nonoBinPath, "run", ...flags, "--", ...cmd];
  return { cmd: wrappedCmd, applied: true };
}

/** Heuristic: treat as a file (non-recursive flag) if the basename has a dot
 * AND the path doesn't end with a separator. Otherwise treat as a directory. */
function pickPathFlag(dirFlag: string, fileFlag: string, p: string): string[] {
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const base = trimmed.split("/").pop() ?? "";
  const looksLikeFile = base.includes(".") && !p.endsWith("/");
  return [looksLikeFile ? fileFlag : dirFlag, p];
}

/**
 * Install a user-provided profile JSON into `~/.config/nono/profiles/` under a
 * unique name and wrap the command with `--profile <name>`. Returns a cleanup
 * that unlinks the installed file.
 */
async function installProfileFile(
  nonoBinPath: string,
  cmd: string[],
  srcPath: string,
): Promise<SandboxApplyResult> {
  const fs = await import("node:fs");
  const fsp = fs.promises;
  const path = await import("node:path");
  const os = await import("node:os");
  const crypto = await import("node:crypto");

  const profilesDir = path.join(os.homedir(), ".config", "nono", "profiles");
  await fsp.mkdir(profilesDir, { recursive: true });

  const profileName = `agent-sdk-${crypto.randomBytes(8).toString("hex")}`;
  const installedPath = path.join(profilesDir, `${profileName}.json`);

  const contents = await fsp.readFile(srcPath, "utf-8");
  await fsp.writeFile(installedPath, contents, "utf-8");

  const wrappedCmd = [nonoBinPath, "run", "--profile", profileName, "--", ...cmd];
  return {
    cmd: wrappedCmd,
    applied: true,
    cleanup: async () => {
      try {
        await fsp.unlink(installedPath);
      } catch {
        // ignore cleanup errors
      }
    },
  };
}
