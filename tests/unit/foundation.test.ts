import { describe, test, expect } from "bun:test";
import {
  userMessageEvent,
  sessionForkedEvent,
  availableCommandsEvent,
  permissionRequestEvent,
  sessionEvent,
  textDeltaEvent,
} from "../../src/events.js";
import { createStreamResult } from "../../src/stream.js";
import type { AgentEvent } from "../../src/types.js";

describe("new event factories", () => {
  test("userMessageEvent", () => {
    expect(userMessageEvent("hi", "m-1")).toEqual({
      type: "user_message",
      text: "hi",
      messageId: "m-1",
    });
  });

  test("sessionForkedEvent", () => {
    expect(sessionForkedEvent("new-id", "old-id")).toEqual({
      type: "session_forked",
      sessionId: "new-id",
      sourceSessionId: "old-id",
    });
  });

  test("availableCommandsEvent", () => {
    const cmds = [{ name: "/plan", description: "plan mode" }];
    expect(availableCommandsEvent(cmds)).toEqual({
      type: "available_commands",
      commands: cmds,
    });
  });

  test("permissionRequestEvent with all fields", () => {
    const respond = async () => {};
    const ev = permissionRequestEvent(
      "req-1",
      "shell",
      { cmd: "ls" },
      {
        annotations: { destructiveHint: true },
        respond,
      },
    );
    expect(ev).toEqual({
      type: "permission_request",
      requestId: "req-1",
      toolName: "shell",
      details: { cmd: "ls" },
      annotations: { destructiveHint: true },
      respond,
    });
  });

  test("permissionRequestEvent without opts", () => {
    const ev = permissionRequestEvent("req-2", "fs", { path: "/tmp" });
    expect(ev.type).toBe("permission_request");
    if (ev.type === "permission_request") {
      expect(ev.annotations).toBeUndefined();
      expect(ev.respond).toBeUndefined();
    }
  });
});

describe("stream abort synthesizes turn_end cancelled", () => {
  test("fullStream sees turn_end {stopReason:'cancelled'} after abort", async () => {
    async function* slowStream(): AsyncIterable<AgentEvent> {
      yield sessionEvent("s-1");
      yield textDeltaEvent("Hello");
      await new Promise((r) => setTimeout(r, 100));
      yield textDeltaEvent(" World");
    }

    const result = createStreamResult(slowStream(), "claude");
    setTimeout(() => result.abort(), 20);

    const collected: AgentEvent[] = [];
    for await (const ev of result.fullStream) {
      collected.push(ev);
    }

    // Last event must be turn_end with stopReason cancelled.
    const last = collected[collected.length - 1]!;
    expect(last.type).toBe("turn_end");
    if (last.type === "turn_end") {
      expect(last.stopReason).toBe("cancelled");
    }
  });

  test("does not double-emit turn_end when provider already emitted one", async () => {
    async function* cleanStream(): AsyncIterable<AgentEvent> {
      yield sessionEvent("s-1");
      yield textDeltaEvent("done");
      yield { type: "turn_end", stopReason: "end_turn" };
    }

    const result = createStreamResult(cleanStream(), "claude");
    const collected: AgentEvent[] = [];
    for await (const ev of result.fullStream) {
      collected.push(ev);
    }

    const turnEnds = collected.filter((e) => e.type === "turn_end");
    expect(turnEnds.length).toBe(1);
    if (turnEnds[0]?.type === "turn_end") {
      expect(turnEnds[0].stopReason).toBe("end_turn");
    }
  });

  test("external AbortSignal triggers cancelled turn_end", async () => {
    const ac = new AbortController();
    async function* slowStream(): AsyncIterable<AgentEvent> {
      yield sessionEvent("s-1");
      yield textDeltaEvent("partial");
      await new Promise((r) => setTimeout(r, 100));
      yield textDeltaEvent(" more");
    }

    const result = createStreamResult(slowStream(), "claude", ac.signal);
    setTimeout(() => ac.abort(), 20);

    const collected: AgentEvent[] = [];
    for await (const ev of result.fullStream) {
      collected.push(ev);
    }

    const last = collected[collected.length - 1]!;
    expect(last.type).toBe("turn_end");
    if (last.type === "turn_end") {
      expect(last.stopReason).toBe("cancelled");
    }
  });
});
