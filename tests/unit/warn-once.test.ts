import { describe, test, expect, spyOn } from "bun:test";
import { claude } from "../../src/providers/claude.js";
import { pi } from "../../src/providers/pi.js";
import type { AgentTool, CallOptions, McpServerConfig, StreamOp } from "../../src/types.js";

// A trivial tool stub — we only need something that has >0 keys on opts.tools.
// The provider never actually invokes execute here because the iterator is
// abandoned after the warn fires.
const dummyTool: AgentTool = {
  name: "noop",
  description: "",
  inputSchema: { type: "object" },
  execute: async () => ({}),
};

const toolsOpt: CallOptions["tools"] = { noop: dummyTool };

/**
 * Shared helper: open an async iterator, pull one value (or catch the error),
 * then close it. We do this twice so we can assert warn-once semantics
 * regardless of whether the stream subsequently errors out on spawn.
 */
async function pumpOnce(iter: AsyncIterator<unknown>): Promise<void> {
  try {
    await iter.next();
  } catch {
    // ignore — we're only checking side effects (console.warn) up to the
    // point where the warn-once check runs.
  } finally {
    try {
      await iter.return?.(undefined);
    } catch {
      // ignore
    }
  }
}

describe("claude provider warn-once on opts.tools", () => {
  test("warns once per provider instance, not per call", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = claude({ cwd: "/tmp", binPath: "/no/such/claude-bin-xyz" });
      const op: StreamOp = { kind: "start", prompt: "hi" };
      const opts: CallOptions = { tools: toolsOpt };

      // Call stream() twice with opts.tools. Warn should fire once.
      await pumpOnce(provider.stream(op, opts)[Symbol.asyncIterator]());
      await pumpOnce(provider.stream(op, opts)[Symbol.asyncIterator]());

      const toolWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("[agent-sdk/claude] opts.tools"),
      );
      expect(toolWarns.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not warn when opts.tools is empty / absent", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = claude({ cwd: "/tmp", binPath: "/no/such/claude-bin-xyz" });
      const op: StreamOp = { kind: "start", prompt: "hi" };
      await pumpOnce(provider.stream(op, {})[Symbol.asyncIterator]());
      await pumpOnce(provider.stream(op, { tools: {} })[Symbol.asyncIterator]());
      const toolWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("[agent-sdk/claude] opts.tools"),
      );
      expect(toolWarns.length).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("separate provider instances warn independently", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const a = claude({ cwd: "/tmp", binPath: "/no/such/claude-bin-xyz" });
      const b = claude({ cwd: "/tmp", binPath: "/no/such/claude-bin-xyz" });
      const op: StreamOp = { kind: "start", prompt: "hi" };
      const opts: CallOptions = { tools: toolsOpt };
      await pumpOnce(a.stream(op, opts)[Symbol.asyncIterator]());
      await pumpOnce(b.stream(op, opts)[Symbol.asyncIterator]());
      const toolWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("[agent-sdk/claude] opts.tools"),
      );
      // Each instance warns once independently → 2 total.
      expect(toolWarns.length).toBe(2);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("mcpServers merge (config + opts)", () => {
  test("duplicate name across config.mcpServers and opts.mcpServers surfaces as compile error", async () => {
    // The mcp compiler rejects duplicate server names. If opts.mcpServers is
    // correctly merged with config.mcpServers, a server whose name already
    // appears in config will be flagged — proving the merge happened.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dup: McpServerConfig = {
        name: "fs",
        transport: { type: "stdio", command: "mcp-fs" },
      };
      const provider = claude({
        cwd: "/tmp",
        binPath: "/no/such/claude-bin-xyz",
        mcpServers: [dup],
      });
      const op: StreamOp = { kind: "start", prompt: "hi" };
      const opts: CallOptions = { mcpServers: [dup] };

      let err: Error | undefined;
      const iter = provider.stream(op, opts)[Symbol.asyncIterator]();
      try {
        // The stream setup runs compileMcp early; it will throw on duplicate name.
        // Iterate until it either throws or the first event yields.
        for (let i = 0; i < 5; i++) {
          await iter.next();
        }
      } catch (e) {
        err = e as Error;
      } finally {
        try {
          await iter.return?.(undefined);
        } catch {
          // ignore
        }
      }
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/Duplicate MCP server name/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("pi provider warn-once", () => {
  test("warns once per instance on opts.tools", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = pi({ cwd: "/tmp", binPath: "/no/such/pi-bin-xyz" });
      const op: StreamOp = { kind: "start", prompt: "hi" };
      const opts: CallOptions = { tools: toolsOpt };
      await pumpOnce(provider.stream(op, opts)[Symbol.asyncIterator]());
      await pumpOnce(provider.stream(op, opts)[Symbol.asyncIterator]());
      const toolWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("[agent-sdk/pi] opts.tools"),
      );
      expect(toolWarns.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("warns once per instance on opts.mcpServers", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const provider = pi({ cwd: "/tmp", binPath: "/no/such/pi-bin-xyz" });
      const op: StreamOp = { kind: "start", prompt: "hi" };
      const mcpServers: McpServerConfig[] = [
        {
          name: "fs",
          transport: { type: "stdio", command: "mcp-fs", args: [] },
        },
      ];
      const opts: CallOptions = { mcpServers };
      await pumpOnce(provider.stream(op, opts)[Symbol.asyncIterator]());
      await pumpOnce(provider.stream(op, opts)[Symbol.asyncIterator]());
      const mcpWarns = warnSpy.mock.calls.filter((args) =>
        String(args[0] ?? "").includes("[agent-sdk/pi] opts.mcpServers"),
      );
      expect(mcpWarns.length).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
