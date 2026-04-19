import { describe, test, expect } from "bun:test";
import { isProviderAvailable, probeProvider, detectAgents } from "../../src/index.js";

describe("isProviderAvailable", () => {
  test("returns boolean for known providers", async () => {
    const result = await isProviderAvailable("claude");
    expect(typeof result).toBe("boolean");
  });

  test("returns false for non-existent binary path", async () => {
    const result = await isProviderAvailable("claude", {
      binPath: "/no/such/binary-12345",
    });
    expect(result).toBe(false);
  });

  test("matches detectAgents result for installed providers", async () => {
    const all = await detectAgents();
    const claudeAvail = await isProviderAvailable("claude");
    expect(claudeAvail).toBe(all.claude.available);
  });
});

describe("probeProvider", () => {
  test("returns AgentInfo with capabilities for known provider", async () => {
    const info = await probeProvider("copilot");
    expect(info.available).toBeDefined();
    if (info.available) {
      expect(info.capabilities).toBeDefined();
      expect(info.capabilities?.acp).toBe(true);
      expect(info.capabilities?.sdk).toBe(true);
    }
  });

  test("returns {available:false} for missing binary", async () => {
    const info = await probeProvider("pi", { binPath: "/no/such/binary-12345" });
    expect(info.available).toBe(false);
  });
});
