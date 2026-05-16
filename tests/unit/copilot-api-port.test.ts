import { describe, expect, test } from "bun:test";
import { resolveCopilotApiEndpoint } from "../../src/copilot-api.ts";

describe("resolveCopilotApiEndpoint", () => {
  test("defaults to http://localhost:4141", () => {
    const r = resolveCopilotApiEndpoint({});
    expect(r.port).toBe(4141);
    expect(r.baseUrl).toBe("http://localhost:4141");
  });

  test("config.port overrides baseUrl port (the original bug)", () => {
    const r = resolveCopilotApiEndpoint({
      baseUrl: "http://localhost:4141",
      port: 4242,
    });
    expect(r.port).toBe(4242);
    // baseUrl must be rewritten to match the effective port; previously the
    // spawn used 4242 but the probe still hit 4141.
    expect(r.baseUrl).toBe("http://localhost:4242");
  });

  test("port from baseUrl is used when no explicit port", () => {
    const r = resolveCopilotApiEndpoint({ baseUrl: "http://localhost:5555" });
    expect(r.port).toBe(5555);
    expect(r.baseUrl).toBe("http://localhost:5555");
  });

  test("respects non-localhost host", () => {
    const r = resolveCopilotApiEndpoint({
      baseUrl: "http://api.internal:9000",
      port: 9001,
    });
    expect(r.port).toBe(9001);
    expect(r.baseUrl).toBe("http://api.internal:9001");
  });

  test("https without explicit port resolves to 443", () => {
    const r = resolveCopilotApiEndpoint({ baseUrl: "https://example.com" });
    expect(r.port).toBe(443);
    // URL.toString() drops the default 443 from https URLs; either form is fine.
    expect(["https://example.com", "https://example.com:443"]).toContain(r.baseUrl);
  });

  test("strips trailing slash for clean probe concatenation", () => {
    const r = resolveCopilotApiEndpoint({ baseUrl: "http://localhost:4141/" });
    expect(r.baseUrl.endsWith("/")).toBe(false);
  });
});
