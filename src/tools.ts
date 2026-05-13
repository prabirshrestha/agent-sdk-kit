import { z } from "zod";
import type { AgentTool, ToolContext } from "./types.js";
import { AgentError } from "./errors.js";
import { permissionRequestEvent } from "./events.js";

/**
 * Build the placeholder result transports return for "host-handled"
 * tools (`AgentTool` with no `execute`). The host observes the
 * `tool_call` event on the stream and acts post-turn; the SDK still
 * needs a result to feed back to the agent so its turn can continue.
 *
 * Shape: `{ ok: true, input }` — a small, neutral ack. Hosts that
 * want richer feedback should provide a real `execute` instead.
 */
export function synthesizeHostHandledResult(input: unknown): {
  ok: true;
  input: unknown;
} {
  return { ok: true, input };
}

/**
 * True when an `AgentTool` ships without an `execute` — the host is
 * expected to handle the call out-of-band via the tool_call event.
 */
export function isHostHandledTool(tool: AgentTool): boolean {
  return typeof tool.execute !== "function";
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  description: string;
  inputSchema: Record<string, unknown> | { _zod: any /* zod schema */ };
  /**
   * Tool implementation. Return a value / Promise, or an async generator that
   * yields progress updates and finishes with the final result (Vercel-AI-SDK
   * shape). The last yielded value becomes the tool's return value; earlier
   * yields are surfaced via `ctx.emit` when the provider supports it.
   *
   * `ctx.emit` is populated by transports that support in-turn progress
   * (currently the Copilot SDK transport, which surfaces each intermediate
   * yield as a `tool_progress` AgentEvent on the stream). For all other
   * transports `ctx.emit` is undefined and intermediate yields are silently
   * dropped — only the final yielded value is surfaced as the tool result.
   */
  execute: (input: Input, ctx: ToolContext) => Promise<Output> | Output | AsyncIterable<Output>;
  /**
   * Vercel-style approval gate. When truthy (or the predicate returns true),
   * the wrapper emits a `permission_request` AgentEvent via `ctx.emit`
   * BEFORE invoking `execute()`. The tool runs only when the request is
   * approved via `respond("allow")`; a `respond("deny")` short-circuits with
   * `{ isError: true, message: "denied by user approval gate" }` and
   * `execute()` is never called.
   *
   * When `ctx.emit` is undefined (transport has no progress channel) the
   * gate is silently skipped and `execute()` runs directly. Best-effort.
   */
  needsApproval?: boolean | ((input: Input, ctx: ToolContext) => boolean | Promise<boolean>);
}

function isZodSchema(schema: unknown): boolean {
  return (
    !!schema &&
    typeof schema === "object" &&
    "_def" in (schema as object) &&
    "parse" in (schema as object)
  );
}

/**
 * Convert a Zod schema into a JSON Schema using Zod v4's built-in
 * `z.toJSONSchema`. Synchronous.
 *
 * Use this prior to calling `tool()` when defining a tool from a Zod schema:
 * ```ts
 * const inputSchema = fromZod(z.object({ q: z.string() }));
 * const t = tool("search", { description, inputSchema, execute });
 * ```
 */
export function fromZod(zodSchema: unknown): Record<string, unknown> {
  if (typeof (z as any)?.toJSONSchema !== "function") {
    throw new AgentError(
      "invalid_input",
      "fromZod requires Zod v4 (z.toJSONSchema). Upgrade `zod` to ^4.0.0.",
      undefined,
      "zod_converter_missing",
    );
  }
  return (z as any).toJSONSchema(zodSchema) as Record<string, unknown>;
}

/**
 * Vercel-AI-style `tool()` helper for defining custom tools.
 *
 * `def.inputSchema` MUST be a plain JSON Schema object. If you have a Zod
 * schema, convert it first with `fromZod(zodSchema)` and pass the result
 * here. Passing a raw Zod schema throws an `AgentError("invalid_input", …)`
 * with code `zod_schema_not_converted`.
 *
 * Wraps `execute` so a thrown error is caught and returned as
 * `{isError: true, message}` rather than crashing the stream consumer.
 */
export function tool<I = unknown, O = unknown>(name: string, def: ToolDefinition<I, O>): AgentTool {
  if (isZodSchema(def.inputSchema)) {
    throw new AgentError(
      "invalid_input",
      `Zod schema passed to tool('${name}'). Pre-convert with \`fromZod(zodSchema)\` and pass the result as inputSchema.`,
      undefined,
      "zod_schema_not_converted",
    );
  }

  const inputSchema = def.inputSchema as Record<string, unknown>;
  const needsApproval = def.needsApproval;

  const wrappedExecute = async (input: unknown, ctx: ToolContext): Promise<unknown> => {
    try {
      // Vercel-style approval gate. Evaluated BEFORE calling def.execute.
      // The gate is best-effort: it only activates when the transport
      // populates ctx.emit (currently: copilot SDK). Without ctx.emit there
      // is no channel to surface a permission_request event, so we fall
      // through to execute() silently.
      if (needsApproval && ctx.emit) {
        const shouldGate =
          typeof needsApproval === "function"
            ? await needsApproval(input as I, ctx)
            : Boolean(needsApproval);
        if (shouldGate) {
          const requestId = crypto.randomUUID();
          let resolveDecision!: (d: "allow" | "deny") => void;
          const decisionPromise = new Promise<"allow" | "deny">((resolve) => {
            resolveDecision = resolve;
          });
          ctx.emit(
            permissionRequestEvent(requestId, name, input, {
              respond: async (d) => resolveDecision(d),
            }),
          );
          const decision = await decisionPromise;
          if (decision === "deny") {
            return { isError: true, message: "denied by user approval gate" };
          }
        }
      }

      const ret = def.execute(input as I, ctx);
      // AsyncIterable / async generator: iterate, forward intermediate yields
      // via ctx.emit (if provided), return the final yielded value.
      if (ret && typeof ret === "object" && Symbol.asyncIterator in ret) {
        let last: unknown = undefined;
        let any = false;
        for await (const chunk of ret as AsyncIterable<unknown>) {
          if (any && ctx.emit) ctx.emit(last);
          last = chunk;
          any = true;
        }
        return last;
      }
      return await Promise.resolve(ret);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, message };
    }
  };

  return {
    name,
    description: def.description,
    inputSchema,
    ...(needsApproval !== undefined
      ? { needsApproval: needsApproval as AgentTool["needsApproval"] }
      : {}),
    execute: wrappedExecute,
  };
}
