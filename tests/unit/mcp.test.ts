import { describe, test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { compileMcp } from "../../src/mcp.js";
import type { McpServerConfig } from "../../src/types.js";

describe("compileMcp", () => {
  test("returns empty object for undefined servers", async () => {
    const result = await compileMcp(undefined, "claude");
    expect(result).toEqual({});
  });

  test("returns empty object for empty servers array", async () => {
    const result = await compileMcp([], "claude");
    expect(result).toEqual({});
  });

  test("throws on duplicate server names for claude target", async () => {
    const servers: McpServerConfig[] = [
      {
        name: "dup",
        transport: { type: "stdio", command: "foo" },
      },
      {
        name: "dup",
        transport: { type: "stdio", command: "bar" },
      },
    ];
    await expect(compileMcp(servers, "claude")).rejects.toMatchObject({
      kind: "invalid_input",
      code: "mcp_duplicate_name",
    });
  });

  test("throws on duplicate server names for copilot-cli target", async () => {
    const servers: McpServerConfig[] = [
      {
        name: "same",
        transport: { type: "stdio", command: "a" },
      },
      {
        name: "same",
        transport: { type: "stdio", command: "b" },
      },
    ];
    await expect(compileMcp(servers, "copilot-cli")).rejects.toMatchObject({
      kind: "invalid_input",
      code: "mcp_duplicate_name",
    });
  });

  test("throws on duplicate server names for copilot-sdk target", async () => {
    const servers: McpServerConfig[] = [
      { name: "x", transport: { type: "stdio", command: "a" } },
      { name: "x", transport: { type: "stdio", command: "b" } },
    ];
    await expect(compileMcp(servers, "copilot-sdk")).rejects.toMatchObject({
      kind: "invalid_input",
      code: "mcp_duplicate_name",
    });
  });

  test("throws on duplicate server names for opencode-cli target", async () => {
    const servers: McpServerConfig[] = [
      { name: "y", transport: { type: "stdio", command: "a" } },
      { name: "y", transport: { type: "stdio", command: "b" } },
    ];
    await expect(compileMcp(servers, "opencode-cli")).rejects.toMatchObject({
      kind: "invalid_input",
      code: "mcp_duplicate_name",
    });
  });

  test("throws on duplicate server names for acp target", async () => {
    const servers: McpServerConfig[] = [
      { name: "z", transport: { type: "acp" } },
      { name: "z", transport: { type: "acp" } },
    ];
    await expect(compileMcp(servers, "acp")).rejects.toMatchObject({
      kind: "invalid_input",
      code: "mcp_duplicate_name",
    });
  });

  test("accepts distinct server names and writes claude config", async () => {
    const servers: McpServerConfig[] = [
      { name: "a", transport: { type: "stdio", command: "foo" } },
      { name: "b", transport: { type: "stdio", command: "bar" } },
    ];
    const result = await compileMcp(servers, "claude");
    expect(result.claude).toBeDefined();
    try {
      const raw = await fs.readFile(result.claude!.configPath, "utf-8");
      const parsed = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(parsed.mcpServers).sort()).toEqual(["a", "b"]);
    } finally {
      await result.claude!.cleanup();
    }
  });

  test("opencode-cli writes config with type:local, array command, environment, enabled", async () => {
    const servers: McpServerConfig[] = [
      {
        name: "weather",
        transport: {
          type: "stdio",
          command: "uvx",
          args: ["mcp-weather"],
          env: { API_KEY: "abc" },
        },
      },
    ];
    const result = await compileMcp(servers, "opencode-cli");
    expect(result.opencodeCli).toBeDefined();
    try {
      const raw = await fs.readFile(result.opencodeCli!.configPath, "utf-8");
      const parsed = JSON.parse(raw) as { mcp: Record<string, any> };
      const entry = parsed.mcp.weather;
      // Matches McpLocalConfig in @opencode-ai/sdk types (type/command[]/environment/enabled).
      expect(entry.type).toBe("local");
      expect(entry.command).toEqual(["uvx", "mcp-weather"]);
      expect(entry.environment).toEqual({ API_KEY: "abc" });
      expect(entry.enabled).toBe(true);
    } finally {
      await result.opencodeCli!.cleanup();
    }
  });

  test("opencode-cli skips non-stdio transports", async () => {
    const servers: McpServerConfig[] = [
      { name: "ok", transport: { type: "stdio", command: "x" } },
      { name: "remote", transport: { type: "http", url: "https://example.com" } as any },
    ];
    const result = await compileMcp(servers, "opencode-cli");
    try {
      const raw = await fs.readFile(result.opencodeCli!.configPath, "utf-8");
      const parsed = JSON.parse(raw) as { mcp: Record<string, any> };
      expect(Object.keys(parsed.mcp)).toEqual(["ok"]);
    } finally {
      await result.opencodeCli!.cleanup();
    }
  });
});
