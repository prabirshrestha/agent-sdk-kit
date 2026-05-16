import { describe, expect, test } from "bun:test";
import { spawnProcess } from "../../src/runtime.ts";

describe("spawnProcess signal exit mapping", () => {
  test("normal exit returns the actual exit code with signal=null", async () => {
    const proc = spawnProcess(["node", "-e", "process.exit(7)"]);
    const [code, signal] = await Promise.all([proc.exited, proc.exitedSignal]);
    expect(code).toBe(7);
    expect(signal).toBeNull();
  });

  test("clean exit 0 returns 0 with signal=null", async () => {
    const proc = spawnProcess(["node", "-e", ""]);
    const [code, signal] = await Promise.all([proc.exited, proc.exitedSignal]);
    expect(code).toBe(0);
    expect(signal).toBeNull();
  });

  test("SIGTERM-killed child returns 128+SIGTERM and signal='SIGTERM'", async () => {
    // Long-running child that only exits when killed.
    const proc = spawnProcess(["node", "-e", "setTimeout(() => {}, 60000)"]);
    // Give it a moment to start, then SIGTERM.
    await new Promise((r) => setTimeout(r, 50));
    proc.kill("SIGTERM");
    const [code, signal] = await Promise.all([proc.exited, proc.exitedSignal]);
    expect(signal).toBe("SIGTERM");
    // SIGTERM is 15 on POSIX → 128+15=143. Skip the strict check on Windows.
    if (process.platform !== "win32") {
      expect(code).toBe(143);
    } else {
      expect(code).toBeGreaterThan(0);
    }
  });

  test("SIGKILL-killed child returns 128+SIGKILL and signal='SIGKILL'", async () => {
    if (process.platform === "win32") return; // SIGKILL semantics differ on Windows
    const proc = spawnProcess(["node", "-e", "setTimeout(() => {}, 60000)"]);
    await new Promise((r) => setTimeout(r, 50));
    proc.kill("SIGKILL");
    const [code, signal] = await Promise.all([proc.exited, proc.exitedSignal]);
    expect(signal).toBe("SIGKILL");
    expect(code).toBe(137); // 128 + 9
  });
});
