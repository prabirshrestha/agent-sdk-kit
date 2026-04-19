import type { CopilotConfig, ProviderImpl } from "../types.js";
import { createCopilotSdkTransport } from "../transports/sdk-copilot.js";

/**
 * Create a Copilot provider. Uses the official `@github/copilot-sdk` in-process.
 *
 * If you need to drive the copilot CLI over the Agent Client Protocol, use
 * the generic `acp({ spawn: ["copilot", "--acp"] })` factory instead.
 */
export function copilot(config?: CopilotConfig): ProviderImpl {
  return createCopilotSdkTransport(config);
}
