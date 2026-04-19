import type { OpencodeConfig, ProviderImpl } from "../types.js";
import { createOpencodeSdkTransport } from "../transports/sdk-opencode.js";

/**
 * Create an Opencode provider. Uses the official `@opencode-ai/sdk` in-process.
 *
 * If you need to drive the opencode CLI over the Agent Client Protocol, use
 * the generic `acp({ spawn: ["opencode", "serve", "--acp"] })` factory instead.
 */
export function opencode(config?: OpencodeConfig): ProviderImpl {
  return createOpencodeSdkTransport(config);
}
