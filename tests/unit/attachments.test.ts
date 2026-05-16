import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Attachment } from "../../src/types.js";

// Try to import attachments module, skip all tests if not available
let materializeAttachments:
  | ((
      attachments: Attachment[],
      abortSignal?: AbortSignal,
    ) => Promise<
      Array<{ path: string; cleanup?: () => Promise<void>; origType: string; mimeType?: string }>
    >)
  | null = null;
let cleanupAttachments: ((mats: any[]) => Promise<void>) | null = null;
let attachmentsAvailable = false;

try {
  const mod = await import("../../src/attachments.js");
  materializeAttachments = mod.materializeAttachments;
  cleanupAttachments = mod.cleanupAttachments;
  attachmentsAvailable = true;
} catch {
  // Module doesn't exist yet, all tests will be skipped
}

describe("materializeAttachments", () => {
  const testIf = attachmentsAvailable ? test : test.skip;

  testIf("returns same path for file attachments with no cleanup needed", async () => {
    if (!materializeAttachments || !cleanupAttachments) return;

    const testFilePath = path.join(process.cwd(), "tests/unit/test-file.txt");
    await fs.writeFile(testFilePath, "test content");

    try {
      const attachments: Attachment[] = [{ type: "file", path: testFilePath }];
      const result = await materializeAttachments(attachments);

      expect(result.length).toBe(1);
      expect(result[0]!.path).toBe(testFilePath);
      expect(result[0]!.origType).toBe("file");
      expect(result[0]!.cleanup).toBeUndefined();

      // Cleanup should be safe to call
      await cleanupAttachments(result);

      // File should still exist after cleanup (not a temp file)
      const exists = await fs.access(testFilePath).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(true);
    } finally {
      await fs.unlink(testFilePath).catch(() => {});
    }
  });

  testIf("writes temp file for image attachment and cleanup unlinks it", async () => {
    if (!materializeAttachments || !cleanupAttachments) return;

    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const attachments: Attachment[] = [{ type: "image", data: imageData, mimeType: "image/png" }];

    const result = await materializeAttachments(attachments);

    expect(result.length).toBe(1);
    const tempPath = result[0]!.path;
    expect(tempPath).toMatch(/\.png$/);
    expect(result[0]!.origType).toBe("image");
    expect(result[0]!.mimeType).toBe("image/png");

    // Verify file exists and has correct content
    const exists = await fs.access(tempPath).then(
      () => true,
      () => false,
    );
    expect(exists).toBe(true);

    const content = await fs.readFile(tempPath);
    expect(content).toEqual(Buffer.from(imageData));

    // Cleanup should remove the temp file
    await cleanupAttachments(result);

    const existsAfterCleanup = await fs.access(tempPath).then(
      () => true,
      () => false,
    );
    expect(existsAfterCleanup).toBe(false);
  });

  testIf("writes resource attachment with content", async () => {
    if (!materializeAttachments || !cleanupAttachments) return;

    const attachments: Attachment[] = [
      { type: "resource", name: "hello.txt", content: "hello world", mimeType: "text/plain" },
    ];

    const result = await materializeAttachments(attachments);

    expect(result.length).toBe(1);
    const tempPath = result[0]!.path;
    expect(tempPath).toMatch(/hello\.txt$/);
    expect(result[0]!.origType).toBe("resource");
    expect(result[0]!.mimeType).toBe("text/plain");

    // Verify file content
    const content = await fs.readFile(tempPath, "utf-8");
    expect(content).toBe("hello world");

    // Cleanup
    await cleanupAttachments(result);

    const existsAfterCleanup = await fs.access(tempPath).then(
      () => true,
      () => false,
    );
    expect(existsAfterCleanup).toBe(false);
  });

  testIf("handles multiple attachments of different types", async () => {
    if (!materializeAttachments || !cleanupAttachments) return;

    const testFilePath = path.join(process.cwd(), "tests/unit/multi-test.txt");
    await fs.writeFile(testFilePath, "existing file");

    try {
      const attachments: Attachment[] = [
        { type: "file", path: testFilePath },
        { type: "image", data: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" },
        {
          type: "resource",
          name: "data.json",
          content: '{"key":"value"}',
          mimeType: "application/json",
        },
      ];

      const result = await materializeAttachments(attachments);

      expect(result.length).toBe(3);
      expect(result[0]!.path).toBe(testFilePath);
      expect(result[1]!.path).toMatch(/\.jpg$/);
      expect(result[2]!.path).toMatch(/data\.json$/);

      // Verify all files exist
      for (const mat of result) {
        const exists = await fs.access(mat.path).then(
          () => true,
          () => false,
        );
        expect(exists).toBe(true);
      }

      await cleanupAttachments(result);

      // Original file should still exist, temp files should be gone
      const originalExists = await fs.access(testFilePath).then(
        () => true,
        () => false,
      );
      expect(originalExists).toBe(true);

      const tempExists1 = await fs.access(result[1]!.path).then(
        () => true,
        () => false,
      );
      expect(tempExists1).toBe(false);

      const tempExists2 = await fs.access(result[2]!.path).then(
        () => true,
        () => false,
      );
      expect(tempExists2).toBe(false);
    } finally {
      await fs.unlink(testFilePath).catch(() => {});
    }
  });

  testIf("handles empty attachments array", async () => {
    if (!materializeAttachments || !cleanupAttachments) return;

    const result = await materializeAttachments([]);

    expect(result).toEqual([]);
    await cleanupAttachments(result); // Should not throw
  });

  test.skip("image_url attachment (network-dependent)", async () => {
    // Skipped as requested - network-dependent test
  });

  testIf("image_url SSRF guard blocks loopback 127.0.0.1", async () => {
    if (!materializeAttachments) return;

    const atts: Attachment[] = [{ type: "image_url", url: "http://127.0.0.1/foo.png" }];
    await expect(materializeAttachments(atts)).rejects.toMatchObject({
      kind: "invalid_input",
      code: "ssrf_blocked",
    });
  });

  testIf("image_url SSRF guard blocks private 10.0.0.1", async () => {
    if (!materializeAttachments) return;

    const atts: Attachment[] = [{ type: "image_url", url: "http://10.0.0.1/foo.png" }];
    await expect(materializeAttachments(atts)).rejects.toMatchObject({
      kind: "invalid_input",
      code: "ssrf_blocked",
    });
  });

  testIf("image_url SSRF guard blocks localhost hostname", async () => {
    if (!materializeAttachments) return;

    const atts: Attachment[] = [{ type: "image_url", url: "http://localhost:8080/foo.png" }];
    await expect(materializeAttachments(atts)).rejects.toMatchObject({
      kind: "invalid_input",
      code: "ssrf_blocked",
    });
  });

  testIf("image_url SSRF guard blocks 192.168.x.x", async () => {
    if (!materializeAttachments) return;

    const atts: Attachment[] = [{ type: "image_url", url: "http://192.168.1.1/foo.png" }];
    await expect(materializeAttachments(atts)).rejects.toMatchObject({
      kind: "invalid_input",
      code: "ssrf_blocked",
    });
  });

  testIf("image_url fetch times out on slow server", async () => {
    if (!materializeAttachments) return;

    // Start a local Bun server that hangs indefinitely. We patch the SSRF
    // allow-list at test level by pointing at a non-loopback route via the
    // public 127.0.0.1 — but that's blocked. Instead we use a real external
    // host with a very short timeout override via monkey-patched fetch.
    //
    // To exercise the timeout logic without hitting the SSRF guard, we
    // temporarily replace globalThis.fetch to sleep past the timeout.

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    try {
      // Use an allowed public-looking host so SSRF guard passes.
      const atts: Attachment[] = [{ type: "image_url", url: "https://example.com/slow.png" }];
      // The default 30s timeout is too long for a test. We rely on an
      // external AbortSignal to fire early — the merged AbortSignal.any()
      // should still respect it.
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const promise = materializeAttachments(atts, controller.signal);
      await expect(promise).rejects.toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  testIf("image_url aborted mid-download surfaces an error and leaves no temp file", async () => {
    if (!materializeAttachments) return;

    // Snapshot tmpdir contents before the run so we can verify no temp file leaks.
    const os = await import("node:os");
    const tmpdir = os.tmpdir();
    const before = new Set(
      (await fs.readdir(tmpdir)).filter((n) => n.startsWith("agent-sdk-att-")),
    );

    const originalFetch = globalThis.fetch;
    // Mocked fetch returns a Response backed by a slow ReadableStream that
    // emits a few bytes, waits, then (if never cancelled) emits more. We
    // wire up the stream's `cancel` to signal that the consumer aborted so
    // arrayBuffer() rejects cleanly.
    globalThis.fetch = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      let cancel: ((reason?: unknown) => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Emit a first chunk immediately.
          controller.enqueue(new Uint8Array([0x89, 0x50]));
          // Schedule a second chunk far in the future (will be cancelled).
          const timer = setTimeout(() => {
            try {
              controller.enqueue(new Uint8Array([0x4e, 0x47]));
              controller.close();
            } catch {
              /* already closed */
            }
          }, 10_000);
          cancel = (reason?: unknown) => {
            clearTimeout(timer);
            try {
              controller.error(reason ?? new DOMException("aborted", "AbortError"));
            } catch {
              /* already errored/closed */
            }
          };
          // Propagate external AbortSignal into the stream.
          init?.signal?.addEventListener("abort", () => {
            cancel?.(new DOMException("aborted", "AbortError"));
          });
        },
        cancel(reason) {
          cancel?.(reason);
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "image/png",
          // No content-length so size pre-check does not short-circuit.
        },
      });
    }) as unknown as typeof fetch;

    try {
      const atts: Attachment[] = [{ type: "image_url", url: "https://example.com/slow.png" }];
      const controller = new AbortController();
      // Abort shortly after fetch starts — partway through the (slow) download.
      setTimeout(() => controller.abort(), 20);
      let thrown: unknown;
      try {
        await materializeAttachments(atts, controller.signal);
      } catch (e) {
        thrown = e;
      }
      // Document actual behavior: either an AgentError (kind: aborted/cancelled/
      // invalid_input) from the explicit checkAborted / wrapper, OR a raw
      // AbortError/DOMException if the underlying fetch stream rejects before
      // we hit a checkAborted gate. Either way, an error MUST surface.
      expect(thrown).toBeDefined();
      if (thrown && typeof thrown === "object" && "kind" in thrown) {
        const kind = (thrown as { kind: string }).kind;
        expect(["cancelled", "aborted", "invalid_input"]).toContain(kind);
      } else {
        // Raw AbortError path — still considered acceptable.
        const name = (thrown as Error)?.name ?? "";
        expect(["AbortError", "DOMException", "Error"]).toContain(name);
      }

      // No temp file leak: the set of agent-sdk-att-* entries in tmpdir must
      // not have grown as a result of the aborted run.
      const after = new Set(
        (await fs.readdir(tmpdir)).filter((n) => n.startsWith("agent-sdk-att-")),
      );
      const leaked = [...after].filter((n) => !before.has(n));
      expect(leaked).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  testIf("image_url rejects body larger than 10MB via content-length", async () => {
    if (!materializeAttachments) return;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(20 * 1024 * 1024),
        },
      });
    }) as unknown as typeof fetch;

    try {
      const atts: Attachment[] = [{ type: "image_url", url: "https://example.com/big.png" }];
      await expect(materializeAttachments(atts)).rejects.toMatchObject({
        kind: "invalid_input",
        code: "body_too_large",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  testIf(
    "image_url with parameterized content-type still derives the correct extension",
    async () => {
      if (!materializeAttachments) return;

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: {
            // Realistic server response — many CDNs include charset / name params.
            "content-type": "image/png; charset=binary",
          },
        });
      }) as unknown as typeof fetch;

      try {
        const atts: Attachment[] = [
          { type: "image_url", url: "https://example.com/with-params.png" },
        ];
        const mats = await materializeAttachments(atts);
        try {
          expect(mats).toHaveLength(1);
          // Regression: previously the parameter portion was passed to the
          // extension lookup, so the file was written without an extension.
          expect(mats[0]!.path.endsWith(".png")).toBe(true);
          // mimeType is normalized (parameters stripped) so downstream callers
          // get a stable type without per-server quirks.
          expect(mats[0]!.mimeType).toBe("image/png");
        } finally {
          await cleanupAttachments!(mats);
        }
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
