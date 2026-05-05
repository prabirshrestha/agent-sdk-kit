import { describe, test, expect } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import { createAgent, claude, copilot, isProviderAvailable } from "../../../src/index.js";
import type { Attachment, Provider } from "../../../src/index.js";

type Candidate = { name: "claude" | "copilot"; make: () => Provider };

const candidates: Candidate[] = [
  { name: "claude", make: () => claude({ cwd: os.tmpdir(), model: "claude-haiku-4-5" }) },
  { name: "copilot", make: () => copilot({ cwd: os.tmpdir() }) },
];

let chosen: Candidate | null = null;
for (const c of candidates) {
  if (await isProviderAvailable(c.name).catch(() => false)) {
    chosen = c;
    break;
  }
}

describe.skipIf(!chosen)(`attachments e2e (${chosen?.name ?? "none"})`, () => {
  test("attached file content is referenced in response", async () => {
    if (!chosen) return;

    const marker = `pineapple-${crypto.randomUUID().slice(0, 8)}`;
    const filePath = path.join(os.tmpdir(), `agent-sdk-attach-${crypto.randomUUID()}.txt`);
    await fs.writeFile(
      filePath,
      `The secret word is ${marker}. Do not paraphrase; quote it.`,
      "utf-8",
    );

    await using agent = createAgent({ provider: chosen.make() });
    try {
      const attachments: Attachment[] = [{ type: "file", path: filePath }];
      const turn = agent.run({
        prompt:
          "Read the attached file and reply with the secret word it contains. Reply with just the word.",
        options: { attachments },
      });
      const result = await turn.result;
      expect(result.text.toLowerCase()).toContain(marker.toLowerCase());
    } finally {
      await fs.unlink(filePath).catch(() => {});
    }
  }, 180_000);
});
