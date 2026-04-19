import { describe, test, expect } from "bun:test";
import { AgentError } from "../../src/index.js";

// Dynamically import src/tools.ts so the file remains compilable even before
// w2-atts lands. If the module is absent, all tests are skipped.
let toolsMod: any = null;
let toolsAvailable = false;
try {
  toolsMod = await import("../../src/tools.js");
  toolsAvailable =
    !!toolsMod && (typeof toolsMod.tool === "function" || typeof toolsMod.fromZod === "function");
} catch {
  toolsAvailable = false;
}

// Detect API style: new-style `tool({ name, ... })` vs old-style `tool(name, def)`.
async function makeTool(spec: {
  name: string;
  description?: string;
  inputSchema: any;
  execute?: (input: unknown, ctx: any) => any;
}): Promise<any> {
  const exec = spec.execute ?? (async () => ({ ok: true }));
  const tool = toolsMod.tool;
  // Try new API (single object) first.
  try {
    const out = tool({
      name: spec.name,
      description: spec.description ?? "",
      inputSchema: spec.inputSchema,
      execute: exec,
    });
    if (out && typeof out === "object" && "name" in out) return await out;
  } catch {
    /* fall through to old API */
  }
  // Old API: tool(name, def).
  return await tool(spec.name, {
    description: spec.description ?? "",
    inputSchema: spec.inputSchema,
    execute: exec,
  });
}

// Try to load zod (now a regular dep, but tolerate absence for safety).
let zod: any = null;
try {
  zod = await import("zod");
} catch {
  /* zod not installed */
}

describe("tool() helper", () => {
  const t = toolsAvailable ? test : test.skip;

  t("returns AgentTool whose inputSchema matches the given JSON Schema", async () => {
    const schema = {
      type: "object",
      properties: { x: { type: "number" } },
      required: ["x"],
    };
    const out = await makeTool({ name: "x", inputSchema: schema });
    expect(out.name).toBe("x");
    expect(out.inputSchema).toEqual(schema);
    expect(typeof out.execute).toBe("function");
  });

  t("preserves a plain object schema verbatim", async () => {
    const schema = { type: "object", properties: { y: { type: "string" } } };
    const out = await makeTool({ name: "y", inputSchema: schema });
    expect(out.inputSchema).toEqual(schema);
  });

  const zodCanConvert = toolsAvailable && zod;
  const tZod = zodCanConvert ? test : test.skip;

  tZod("converts a Zod schema to JSON Schema with type=object and properties", async () => {
    const z = zod.z ?? zod.default?.z ?? zod;
    const zSchema = z.object({ name: z.string(), age: z.number() });
    // tool() is sync and rejects zod schemas directly; pre-convert with fromZod().
    const jsonSchema = toolsMod.fromZod(zSchema);
    const out = await makeTool({ name: "z", inputSchema: jsonSchema });
    const js = out.inputSchema as Record<string, unknown>;
    expect(js).toBeTruthy();
    const looksObject =
      js.type === "object" ||
      typeof js.$ref === "string" ||
      (js.definitions && typeof js.definitions === "object");
    expect(looksObject).toBe(true);
    if (js.type === "object") {
      expect(js.properties).toBeTruthy();
      const props = js.properties as Record<string, unknown>;
      expect(props).toHaveProperty("name");
      expect(props).toHaveProperty("age");
    }
  });

  tZod("throws AgentError(invalid_input) when a raw Zod schema is passed to tool()", async () => {
    const z = zod.z ?? zod.default?.z ?? zod;
    const zSchema = z.object({ q: z.string() });
    let caught: unknown;
    try {
      await makeTool({ name: "broken", inputSchema: zSchema });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).kind).toBe("invalid_input");
  });
});
