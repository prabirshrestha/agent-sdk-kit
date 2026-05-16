import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Attachment } from "./types.js";
import { AgentError } from "./errors.js";

export interface MaterializedAttachment {
  path: string; // absolute filesystem path
  cleanup?: () => Promise<void>; // unlink temp files
  origType: "file" | "image" | "image_url" | "resource";
  mimeType?: string;
}

/** Default fetch timeout for image_url attachments (30 seconds). */
export const IMAGE_URL_FETCH_TIMEOUT_MS = 30_000;
/** Maximum body size for image_url fetch (10 MB). */
export const IMAGE_URL_MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Check whether a URL's hostname refers to a loopback or private-range address.
 * Used as a basic SSRF guard for image_url fetches.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "" || h === "0.0.0.0") return true;
  // IPv6 loopback / unspecified
  if (h === "::1" || h === "::") return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (/^fc[0-9a-f]{2}:/i.test(h) || /^fd[0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
  // IPv4 literal
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    // 127.0.0.0/8 loopback
    if (a === 127) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 link-local
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function checkAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    throw new AgentError("cancelled", "Attachment materialization aborted", undefined, "aborted");
  }
}

async function rollback(results: MaterializedAttachment[]): Promise<void> {
  await Promise.all(
    results.map((m) =>
      m.cleanup
        ? m.cleanup().catch((err) => {
            console.warn("agent-sdk: attachment cleanup failed", err);
          })
        : Promise.resolve(),
    ),
  );
}

/**
 * Materialize attachments to local files for CLI providers that take @path refs.
 * - {type:"file", path} → resolve to absolute path, verify exists, return as-is, cleanup undefined
 * - {type:"image", data, mimeType} → write bytes to temp file, cleanup unlinks
 * - {type:"image_url", url} → fetch the URL, write to temp file, cleanup unlinks
 * - {type:"resource", name, content, mimeType} → write content as utf-8 to temp file with name as basename, cleanup unlinks
 *
 * @param atts attachments to materialize
 * @param abortSignal optional AbortSignal to cancel materialization between async I/O steps
 */
export async function materializeAttachments(
  atts: Attachment[],
  abortSignal?: AbortSignal,
): Promise<MaterializedAttachment[]> {
  const results: MaterializedAttachment[] = [];

  try {
    for (const att of atts) {
      checkAborted(abortSignal);

      if (att.type === "file") {
        const resolved = path.resolve(att.path);
        try {
          await fs.access(resolved);
        } catch {
          throw new AgentError(
            "invalid_input",
            `Attachment file not found: ${att.path}`,
            undefined,
            "file_not_found",
          );
        }
        checkAborted(abortSignal);
        results.push({
          path: resolved,
          origType: "file",
          cleanup: undefined,
        });
      } else if (att.type === "image") {
        const ext = mimeTypeToExtension(att.mimeType);
        const tempPath = path.join(
          os.tmpdir(),
          `agent-sdk-att-${crypto.randomBytes(8).toString("hex")}${ext}`,
        );
        checkAborted(abortSignal);
        await fs.writeFile(tempPath, att.data);
        await fs.chmod(tempPath, 0o600);
        results.push({
          path: tempPath,
          origType: "image",
          mimeType: att.mimeType,
          cleanup: async () => {
            try {
              await fs.unlink(tempPath);
            } catch (err) {
              console.warn("agent-sdk: attachment cleanup failed", err);
            }
          },
        });
      } else if (att.type === "image_url") {
        checkAborted(abortSignal);
        // SSRF guard: parse URL and block loopback / private-range hosts.
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(att.url);
        } catch {
          throw new AgentError(
            "invalid_input",
            `image_url fetch blocked: invalid URL`,
            undefined,
            "invalid_url",
          );
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          throw new AgentError(
            "invalid_input",
            `image_url fetch blocked: unsupported protocol '${parsedUrl.protocol}'`,
            undefined,
            "ssrf_blocked",
          );
        }
        if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
          throw new AgentError(
            "invalid_input",
            "image_url fetch blocked: private/loopback address",
            undefined,
            "ssrf_blocked",
          );
        }
        // Merge caller's abortSignal with a default 30s timeout.
        const timeoutSignal = AbortSignal.timeout(IMAGE_URL_FETCH_TIMEOUT_MS);
        const fetchSignal = abortSignal
          ? AbortSignal.any([abortSignal, timeoutSignal])
          : timeoutSignal;
        const response = await fetch(att.url, { signal: fetchSignal });
        if (!response.ok) {
          throw new AgentError(
            "invalid_input",
            `Failed to fetch image_url: ${response.statusText}`,
            { status: response.status, statusText: response.statusText },
            "fetch_failed",
          );
        }
        // Reject responses that declare a body larger than our limit before downloading.
        const contentLengthHeader = response.headers.get("content-length");
        if (contentLengthHeader) {
          const declaredLen = Number(contentLengthHeader);
          if (Number.isFinite(declaredLen) && declaredLen > IMAGE_URL_MAX_BODY_BYTES) {
            throw new AgentError(
              "invalid_input",
              `image_url fetch blocked: body exceeds ${IMAGE_URL_MAX_BODY_BYTES} bytes`,
              undefined,
              "body_too_large",
            );
          }
        }
        checkAborted(abortSignal);
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > IMAGE_URL_MAX_BODY_BYTES) {
          throw new AgentError(
            "invalid_input",
            `image_url fetch blocked: body exceeds ${IMAGE_URL_MAX_BODY_BYTES} bytes`,
            undefined,
            "body_too_large",
          );
        }
        const rawContentType = response.headers.get("content-type") || "image/png";
        // Strip parameters like "image/png; charset=binary" before extension lookup
        // — the parameterized form does not match the mimeTypeToExtension map.
        const contentType = rawContentType.split(";")[0]?.trim() || "image/png";
        const ext = mimeTypeToExtension(contentType);
        const tempPath = path.join(
          os.tmpdir(),
          `agent-sdk-att-${crypto.randomBytes(8).toString("hex")}${ext}`,
        );
        checkAborted(abortSignal);
        await fs.writeFile(tempPath, new Uint8Array(buffer));
        await fs.chmod(tempPath, 0o600);
        results.push({
          path: tempPath,
          origType: "image_url",
          mimeType: contentType,
          cleanup: async () => {
            try {
              await fs.unlink(tempPath);
            } catch (err) {
              console.warn("agent-sdk: attachment cleanup failed", err);
            }
          },
        });
      } else if (att.type === "resource") {
        const basename = att.name.replace(/[/\\]/g, "_");
        const tempPath = path.join(
          os.tmpdir(),
          `agent-sdk-att-${crypto.randomBytes(8).toString("hex")}-${basename}`,
        );
        checkAborted(abortSignal);
        await fs.writeFile(tempPath, att.content, "utf-8");
        await fs.chmod(tempPath, 0o600);
        results.push({
          path: tempPath,
          origType: "resource",
          mimeType: att.mimeType,
          cleanup: async () => {
            try {
              await fs.unlink(tempPath);
            } catch (err) {
              console.warn("agent-sdk: attachment cleanup failed", err);
            }
          },
        });
      }
    }
  } catch (err) {
    await rollback(results);
    throw err;
  }

  return results;
}

/**
 * Clean up materialized attachments (unlink temp files). Uses `Promise.allSettled`
 * so a single failure does not prevent the remaining cleanups from running.
 */
export async function cleanupAttachments(mats: MaterializedAttachment[]): Promise<void> {
  await Promise.allSettled(mats.map((mat) => (mat.cleanup ? mat.cleanup() : Promise.resolve())));
}

/**
 * Derive file extension from MIME type.
 */
function mimeTypeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "text/plain": ".txt",
    "text/html": ".html",
    "text/markdown": ".md",
    "application/json": ".json",
    "application/xml": ".xml",
  };
  return map[mimeType.toLowerCase()] || "";
}
