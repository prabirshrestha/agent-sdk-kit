import { describe, test, expect } from "bun:test";
import { createAgent, claude, isProviderAvailable } from "../../src/index.js";
import type { SandboxConfig, Provider } from "../../src/index.js";

// Compile-time assertion: SandboxConfig shape.
const sandbox: SandboxConfig = {
  mode: "cwd",
  failIfUnavailable: false,
};

type Candidate = {
  name: "claude";
  make: (sb: SandboxConfig) => Provider;
};
const candidates: Candidate[] = [
  {
    name: "claude",
    make: (sb) => claude({ cwd: "/tmp", model: "claude-haiku-4-5", sandbox: sb }),
  },
];

let chosen: Candidate | null = null;
for (const c of candidates) {
  if (await isProviderAvailable(c.name).catch(() => false)) {
    chosen = c;
    break;
  }
}

describe.skipIf(!chosen)(`sandbox e2e (${chosen?.name ?? "none"})`, () => {
  test("start() with sandbox option does not throw at construction", async () => {
    if (!chosen) return;
    // Sandbox is configured on the provider factory, not on createAgent.
    await using agent = createAgent({ provider: chosen.make(sandbox) });
    expect(() => {
      const turn = agent.run({ prompt: "hello" });
      turn.result.catch(() => {});
      turn.abort();
    }).not.toThrow();
  }, 30_000);
});

test("SandboxConfig type compiles", () => {
  expect(sandbox.mode).toBe("cwd");
  expect(sandbox.failIfUnavailable).toBe(false);
});
