import { describe, expect, test } from "bun:test";
import { greet } from "../src/index.ts";

describe("greet", () => {
  test("returns greeting with name", () => {
    expect(greet("world")).toBe("Hello, world!");
  });

  test("returns greeting with empty string", () => {
    expect(greet("")).toBe("Hello, !");
  });
});
