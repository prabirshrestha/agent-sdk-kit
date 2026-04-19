import type { AcpConfig, ProviderImpl, StreamOp, CallOptions, AgentEvent } from "../types.js";
import { createAcpTransport } from "../transports/acp.js";
import { notSupported } from "../errors.js";

/**
 * Create an ACP provider for arbitrary ACP-compatible servers.
 *
 * This is the standalone provider for targeting any ACP-speaking CLI.
 *
 * @example
 * ```ts
 * const agent = createAgent({
 *   provider: acp({
 *     spawn: ["copilot", "--acp"],
 *     cwd: process.cwd(),
 *   }),
 * });
 * ```
 */
export function acp(config: AcpConfig): ProviderImpl {
  const transport = createAcpTransport(config.spawn, config.cwd, config.env);

  return {
    name: "acp",
    transport: "acp",
    stream(op: StreamOp, opts: CallOptions): AsyncIterable<AgentEvent> {
      // Pass onPermissionRequest through to the underlying transport so it can
      // gate tool calls instead of auto-approving.
      return transport.stream(op, opts);
    },
    async deleteSession(_sessionId: string): Promise<void> {
      throw notSupported("ACP transport does not support session deletion", "delete_unsupported");
    },
    dispose: transport.dispose.bind(transport),
  };
}
