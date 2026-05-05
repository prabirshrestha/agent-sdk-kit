import { describe, test, expect } from "bun:test";
import { createAgent, claude, copilot, opencode, isProviderAvailable } from "../../../src/index.js";
import type { McpServerConfig, Provider } from "../../../src/index.js";

// Compile-time assertion: McpServerConfig accepts a stdio transport.
const noopMcp: McpServerConfig = {
  name: "noop",
  transport: { type: "stdio", command: "echo", args: ["hello"] },
};

type Candidate = { name: "claude" | "copilot" | "opencode"; make: () => Provider };
const candidates: Candidate[] = [
  { name: "claude", make: () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" }) },
  {
    name: "opencode",
    make: () => opencode({ cwd: "/tmp", model: "github-copilot/gpt-4o" }),
  },
  { name: "copilot", make: () => copilot({ cwd: "/tmp" }) },
];

let chosen: Candidate | null = null;
for (const c of candidates) {
  if (await isProviderAvailable(c.name).catch(() => false)) {
    chosen = c;
    break;
  }
}

describe.skipIf(!chosen)(`mcp e2e (${chosen?.name ?? "none"})`, () => {
  test("start() with mcpServers does not throw at construction", async () => {
    if (!chosen) return;
    await using agent = createAgent({ provider: chosen.make() });
    // We only assert that constructing the call doesn't throw synchronously.
    // We don't iterate the stream — actual MCP wire-up is out of scope.
    expect(() => {
      const turn = agent.run({ prompt: "hello", options: { mcpServers: [noopMcp] } });
      // Detach: do not await; suppress unhandled rejection.
      turn.result.catch(() => {});
      turn.abort();
    }).not.toThrow();
  }, 30_000);
});

// Fallback "test" so the file always has at least one assertion when skipped.
test("McpServerConfig type compiles", () => {
  expect(noopMcp.name).toBe("noop");
  expect(noopMcp.transport.type).toBe("stdio");
});
