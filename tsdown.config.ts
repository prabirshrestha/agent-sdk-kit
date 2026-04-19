import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  external: [
    "@github/copilot-sdk",
    "@opencode-ai/sdk",
    "@zed-industries/agent-client-protocol",
    "zod",
    "zod-to-json-schema",
  ],
});
