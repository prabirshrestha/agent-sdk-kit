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
 *
 * Pass `sandbox` to wrap the spawned ACP child with `nono run` (see the
 * `SandboxConfig` docs). This is the supported path for sandboxing copilot /
 * opencode, since their default in-process SDK transports have no subprocess
 * to wrap.
 */
export function acp(config: AcpConfig): ProviderImpl {
  const transport = createAcpTransport(config.spawn, config.cwd, config.env, config.sandbox);

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
