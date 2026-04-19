import type { AgentInfo, ProviderName } from "./types.js";
import { spawnProcess, which as whichBin } from "./runtime.js";

// Version floors for warning generation
const VERSION_FLOORS: Record<string, string> = {
  claude: "1.0.0",
  copilot: "0.1.0",
  opencode: "1.4.0",
  pi: "0.1.0",
};

/**
 * Detect which coding-agent CLIs are available on PATH.
 * Returns availability, version, and binary path for each known agent.
 */
export async function detectAgents(): Promise<{
  claude: AgentInfo;
  copilot: AgentInfo;
  opencode: AgentInfo;
  pi: AgentInfo;
}> {
  const [claude, copilot, opencode, pi] = await Promise.all([
    probeAgent("claude", ["claude", "--version"]),
    probeAgent("copilot", ["copilot", "--version"]),
    probeAgent("opencode", ["opencode", "--version"]),
    probeAgent("pi", ["pi", "--version"]),
  ]);
  return { claude, copilot, opencode, pi };
}

/**
 * Quick availability check for a single provider.
 *
 * Returns `true` if the provider's CLI binary is found on PATH (or at the
 * supplied `binPath`) and its `--version` invocation exits 0.
 *
 * Useful for guarding `createAgent({ provider: claude() })` calls when you
 * don't know which agents the user has installed.
 *
 * @example
 *   if (await isProviderAvailable("claude")) {
 *     // safe to use claude()
 *   }
 *
 * @example
 *   // Custom binary path
 *   await isProviderAvailable("opencode", { binPath: "/opt/opencode" });
 */
export async function isProviderAvailable(
  name: ProviderName,
  opts?: { binPath?: string },
): Promise<boolean> {
  const bin = opts?.binPath ?? name;
  const info = await probeAgent(name, [bin, "--version"]);
  return info.available;
}

/**
 * Get full info (version, binPath, capabilities, warnings) for one provider.
 * Use this when you need richer detail than `isProviderAvailable`.
 */
export async function probeProvider(
  name: ProviderName,
  opts?: { binPath?: string },
): Promise<AgentInfo> {
  const bin = opts?.binPath ?? name;
  return probeAgent(name, [bin, "--version"]);
}

async function probeAgent(name: string, versionCmd: string[]): Promise<AgentInfo> {
  try {
    const proc = spawnProcess(versionCmd, {
      stdin: "ignore",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return { available: false };
    }

    const version = parseVersion(output, name);
    const binPath = await findBin(name);
    const capabilities = getCapabilities(name);
    const warnings = getVersionWarnings(name, version);

    const info: AgentInfo = {
      available: true,
      version,
      binPath,
      capabilities,
    };

    if (warnings.length > 0) {
      info.warnings = warnings;
    }

    return info;
  } catch {
    return { available: false };
  }
}

/**
 * Get capabilities for a given agent based on its name.
 */
function getCapabilities(name: string): AgentInfo["capabilities"] {
  switch (name) {
    case "claude":
      return {
        acp: false,
        mcp: { stdio: true, http: true },
        sessionFork: true,
        sdk: false,
        customTools: false,
        attachments: true,
      };
    case "copilot":
      return {
        acp: true,
        mcp: { stdio: true, http: false },
        sessionFork: true,
        sdk: true,
        customTools: true,
        attachments: true,
      };
    case "opencode":
      return {
        acp: true,
        mcp: { stdio: true, http: false },
        sessionFork: true,
        sdk: true,
        customTools: true,
        attachments: true,
      };
    case "pi":
      return {
        acp: false,
        mcp: { stdio: false, http: false },
        sessionFork: false,
        sdk: false,
        customTools: false,
        attachments: true,
      };
    default:
      return {
        acp: false,
        mcp: { stdio: false, http: false },
        sessionFork: false,
        sdk: false,
        customTools: false,
        attachments: false,
      };
  }
}

/**
 * Generate version warnings if the detected version is below the recommended floor.
 */
function getVersionWarnings(name: string, version: string | undefined): string[] {
  if (!version) return [];

  const floor = VERSION_FLOORS[name];
  if (!floor) return [];

  try {
    if (compareVersions(version, floor) < 0) {
      return [`Version ${version} is below recommended minimum ${floor}`];
    }
  } catch {
    // If version comparison fails, don't warn
  }

  return [];
}

/**
 * Compare two semver versions. Returns -1 if a < b, 0 if equal, 1 if a > b.
 */
function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string) => {
    const parts = v.split(/[.-]/);
    return {
      major: parseInt(parts[0] ?? "0", 10) || 0,
      minor: parseInt(parts[1] ?? "0", 10) || 0,
      patch: parseInt(parts[2] ?? "0", 10) || 0,
    };
  };

  const va = parseVersion(a);
  const vb = parseVersion(b);

  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  return va.patch - vb.patch;
}

/**
 * Parse a version string from CLI output. Each CLI has a different format.
 */
function parseVersion(output: string, name: string): string | undefined {
  const text = output.trim();
  if (!text) return undefined;

  switch (name) {
    case "claude": {
      // e.g. "claude 2.1.0" or "Claude Code v2.1.0"
      const m = text.match(/v?(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      return m?.[1];
    }
    case "copilot": {
      // e.g. "GitHub Copilot CLI 1.0.32" or "1.0.32"
      const m = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      return m?.[1];
    }
    case "opencode": {
      // e.g. "opencode version 0.1.0" or just version number
      const m = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      return m?.[1];
    }
    case "pi": {
      const m = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      return m?.[1];
    }
    default: {
      const m = text.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
      return m?.[1];
    }
  }
}

/**
 * Find the binary path for a given agent name using the runtime shim's
 * Node-portable `which()` (falls back to PATH walk; also works under Bun).
 */
async function findBin(name: string): Promise<string | undefined> {
  try {
    const path = await whichBin(name);
    return path ?? undefined;
  } catch {
    return undefined;
  }
}
