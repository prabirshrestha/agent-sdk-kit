import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { McpServerConfig } from "./types.js";
import { AgentError } from "./errors.js";

function checkAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new AgentError("cancelled", "MCP compilation aborted", undefined, "aborted");
  }
}

export interface CompiledMcp {
  // For claude: path to a temp .mcp.json file + cleanup
  claude?: { configPath: string; cleanup: () => Promise<void> };
  // For copilot CLI: path to additional-mcp-config JSON
  copilotCli?: { configPath: string; cleanup: () => Promise<void> };
  // For copilot SDK: array to feed CopilotClient.mcp.config.add(...)
  copilotSdk?: Array<unknown>;
  // For opencode CLI: path to ephemeral opencode.json
  opencodeCli?: { configPath: string; cleanup: () => Promise<void> };
  // For opencode SDK: array of mcp configs
  opencodeSdk?: Array<unknown>;
  // For acp: array to forward in session/new
  acp?: Array<unknown>;
}

/**
 * Per-backend MCP server config compilation.
 * - For claude: write `{ "mcpServers": { name: { command, args, env } } }` to temp file. Skip non-stdio types (warn).
 * - For copilot CLI: similar JSON shape; consult for exact key names.
 * - For copilot SDK: return raw configs (later code will iterate and call client.mcp.config.add()).
 * - For opencode CLI: write minimal opencode.json with `mcp: { name: { command, args, env } }`.
 * - For opencode SDK: same as copilot SDK — pass-through.
 * - For ACP: pass through (forwarded in session/new).
 * Each compiled output has a `cleanup` callback to unlink temp files.
 */
export async function compileMcp(
  servers: McpServerConfig[] | undefined,
  target: "claude" | "copilot-cli" | "copilot-sdk" | "opencode-cli" | "opencode-sdk" | "acp",
  abortSignal?: AbortSignal,
): Promise<CompiledMcp> {
  checkAborted(abortSignal);
  if (!servers || servers.length === 0) {
    return {};
  }

  // Detect duplicate server names up front to avoid silent overwrites in the
  // per-target config objects below.
  const seenNames = new Set<string>();
  for (const server of servers) {
    if (seenNames.has(server.name)) {
      throw new AgentError(
        "invalid_input",
        `Duplicate MCP server name: ${server.name}`,
        undefined,
        "mcp_duplicate_name",
      );
    }
    seenNames.add(server.name);
  }

  switch (target) {
    case "claude": {
      // Write { "mcpServers": { name: { command, args, env } } } to temp file
      const mcpServers: Record<string, unknown> = {};
      for (const server of servers) {
        if (server.transport.type !== "stdio") {
          console.warn(
            `[agent-sdk] MCP server '${server.name}' uses transport '${server.transport.type}' which is not supported by claude CLI; skipping.`,
          );
          continue;
        }
        mcpServers[server.name] = {
          command: server.transport.command,
          args: server.transport.args || [],
          env: server.transport.env || {},
        };
      }
      const configPath = path.join(
        os.tmpdir(),
        `agent-sdk-mcp-${crypto.randomBytes(8).toString("hex")}.json`,
      );
      await fs.writeFile(configPath, JSON.stringify({ mcpServers }, null, 2), "utf-8");
      return {
        claude: {
          configPath,
          cleanup: async () => {
            try {
              await fs.unlink(configPath);
            } catch {
              // ignore
            }
          },
        },
      };
    }

    case "copilot-cli": {
      // Similar to claude: write JSON with mcpServers config
      // Format based on: additional-mcp-config expects { "mcpServers": { ... } }
      const mcpServers: Record<string, unknown> = {};
      for (const server of servers) {
        if (server.transport.type !== "stdio") {
          console.warn(
            `[agent-sdk] MCP server '${server.name}' uses transport '${server.transport.type}' which is not supported by copilot CLI; skipping.`,
          );
          continue;
        }
        mcpServers[server.name] = {
          command: server.transport.command,
          args: server.transport.args || [],
          env: server.transport.env || {},
        };
      }
      const configPath = path.join(
        os.tmpdir(),
        `agent-sdk-mcp-${crypto.randomBytes(8).toString("hex")}.json`,
      );
      await fs.writeFile(configPath, JSON.stringify({ mcpServers }, null, 2), "utf-8");
      return {
        copilotCli: {
          configPath,
          cleanup: async () => {
            try {
              await fs.unlink(configPath);
            } catch {
              // ignore
            }
          },
        },
      };
    }

    case "copilot-sdk": {
      // Return raw configs for client.mcp.config.add() iteration
      return {
        copilotSdk: servers.map((server) => ({
          name: server.name,
          transport: server.transport,
          tools: server.tools,
          timeoutMs: server.timeoutMs,
          _meta: server._meta,
        })),
      };
    }

    case "opencode-cli": {
      // Write minimal opencode.json with `mcp: { name: { command, args, env } }`
      const mcp: Record<string, unknown> = {};
      for (const server of servers) {
        if (server.transport.type !== "stdio") {
          console.warn(
            `[agent-sdk] MCP server '${server.name}' uses transport '${server.transport.type}' which is not supported by opencode CLI; skipping.`,
          );
          continue;
        }
        mcp[server.name] = {
          command: server.transport.command,
          args: server.transport.args || [],
          env: server.transport.env || {},
        };
      }
      const configPath = path.join(
        os.tmpdir(),
        `agent-sdk-mcp-${crypto.randomBytes(8).toString("hex")}.json`,
      );
      await fs.writeFile(configPath, JSON.stringify({ mcp }, null, 2), "utf-8");
      return {
        opencodeCli: {
          configPath,
          cleanup: async () => {
            try {
              await fs.unlink(configPath);
            } catch {
              // ignore
            }
          },
        },
      };
    }

    case "opencode-sdk": {
      // Pass-through like copilot SDK
      return {
        opencodeSdk: servers.map((server) => ({
          name: server.name,
          transport: server.transport,
          tools: server.tools,
          timeoutMs: server.timeoutMs,
          _meta: server._meta,
        })),
      };
    }

    case "acp": {
      // Pass through for session/new
      return {
        acp: servers.map((server) => ({
          name: server.name,
          transport: server.transport,
          tools: server.tools,
          timeoutMs: server.timeoutMs,
          _meta: server._meta,
        })),
      };
    }

    default:
      return {};
  }
}
