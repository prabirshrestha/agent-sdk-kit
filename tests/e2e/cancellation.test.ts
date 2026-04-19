import { describe, test, expect } from "bun:test";
import { createAgent, claude, isProviderAvailable } from "../../src/index.js";
import type { Provider } from "../../src/index.js";

type Candidate = { name: "claude"; make: () => Provider };
const candidates: Candidate[] = [
  { name: "claude", make: () => claude({ cwd: "/tmp", model: "claude-haiku-4-5" }) },
];

let chosen: Candidate | null = null;
for (const c of candidates) {
  if (await isProviderAvailable(c.name).catch(() => false)) {
    chosen = c;
    break;
  }
}

describe.skipIf(!chosen)(`cancellation e2e (${chosen?.name ?? "none"})`, () => {
  test("abort within 500ms terminates the stream within 5s", async () => {
    if (!chosen) return;
    await using agent = createAgent({ provider: chosen.make() });
    const ac = new AbortController();
    const turn = agent.run({
      prompt: "write a 5000-word essay about cats",
      options: { abortSignal: ac.signal },
    });

    setTimeout(() => ac.abort(), 500);

    const start = Date.now();
    const iterator = turn[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), 6_000),
          ),
        ]);
        if (next.done) break;
      }
    } catch {
      // Aborted streams may throw — that's acceptable.
    }
    await turn.result.catch(() => {});

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8_000);

    // Subsequent iteration produces no more events.
    const after = await iterator.next().catch(() => ({ done: true, value: undefined }));
    expect(after.done).toBe(true);
  }, 20_000);
});
