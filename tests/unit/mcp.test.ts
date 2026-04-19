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
});
