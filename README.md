# agent-sdk-kit

A uniform API for driving multiple coding agents (claude, copilot, opencode, pi) from your code. Use the official SDK transport when you want to embed an agent in-process, or fall back to the underlying CLI when that's what you need. Native session resume / fork across all providers.

## Status

⚠️ **Experimental.** APIs may change at any time without notice. Use at your own risk.

## Install

```bash
# bun
bun add agent-sdk-kit

# npm
npm install agent-sdk-kit
```

### Optional SDK dependencies

Install only what the transports you actually use require. Everything below (except `zod`) is declared as an **optional peer dependency** — `agent-sdk-kit` will install without any of them, and they're loaded lazily at runtime by the corresponding transport. The zero-dependency CLI path (`claude`, `pi`) needs none of them.

| Package                                 | Declared as          | Install when you use                                                                        |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------- |
| `@github/copilot-sdk`                   | optional peer dep    | `copilot({ transport: "sdk" })` (copilot default)                                           |
| `@opencode-ai/sdk`                      | optional peer dep    | `opencode({ transport: "sdk" })` (opencode default)                                         |
| `@zed-industries/agent-client-protocol` | optional peer dep    | `acp()` (e.g. wrapping `copilot --acp` or `opencode acp`)                                   |
| `zod`                                   | regular `dependency` | always installed — used by `fromZod()` to convert Zod schemas via Zod v4's `z.toJSONSchema` |

### CLI requirements

At least one of these CLIs must be installed and accessible on your PATH:

- `claude` — [Anthropic Claude CLI](https://github.com/anthropics/claude-code)
- `copilot` — [GitHub Copilot CLI](https://github.com/github/copilot-cli)
- `opencode` — [OpenCode AI CLI](https://github.com/anomalyco/opencode)
- `pi` — [@mariozechner/pi-coding-agent](https://github.com/mariozechner/pi)

## Quick start

```ts
import { createAgent, claude } from "agent-sdk-kit";

const agent = createAgent({ provider: claude() });
const result = agent.run({ prompt: "Say hi" });

console.log(await result.text);
```

## Streaming

Stream text tokens as they arrive:

```ts
import { createAgent, claude } from "agent-sdk-kit";

const agent = createAgent({ provider: claude() });
const result = agent.run({ prompt: "Write a haiku about TypeScript" });

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

Stream all events:

```ts
for await (const event of result.fullStream) {
  if (event.type === "text_delta") {
    process.stdout.write(event.delta);
  } else if (event.type === "tool_call") {
    console.log(`Tool: ${event.name}`);
  }
}
```

## Resume + Fork

Lifecycle is controlled through `options` on `agent.run()`, mirroring
`@anthropic-ai/claude-agent-sdk`'s `query({ prompt, options })`.

```ts
import { createAgent, claude } from "agent-sdk-kit";

const agent = createAgent({ provider: claude() });

// Start a new session
const turn1 = agent.run({ prompt: "Remember the word: banana" });
const sessionId = await turn1.sessionId;

// Resume — continue the same session
const turn2 = agent.run({
  prompt: "What word did I say?",
  options: { resume: sessionId },
});
console.log(await turn2.text); // "banana"

// Fork — branch from the same starting point into a new session
const turn3 = agent.run({
  prompt: "Now reply in French",
  options: { resume: sessionId, forkSession: true },
});
const forkId = await turn3.sessionId; // Different session ID
console.log(await turn3.text);

// Resume at a specific message — rewind the session to a prior message
// UUID and continue from there. Useful for retrying a turn or branching
// off a known-good point. (Currently surfaced through the API but not yet
// supported by any transport — see the feature matrix below.)
const turn4 = agent.run({
  prompt: "Try that again, but shorter",
  options: { resume: sessionId, resumeSessionAt: "<message-uuid>" },
});
console.log(await turn4.text);
```

Other lifecycle options on `RunOptions`:

| Option            | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `resume`          | Continue the session with this id                                            |
| `resumeSessionAt` | Resume at a specific message UUID within the session (requires `resume`)     |
| `forkSession`     | Branch the resumed session into a new session id (requires `resume`)         |
| `continue`        | Continue the most recent conversation                                        |
| `sessionId`       | Pin a UUID for the new session instead of letting the provider auto-generate |

Not every option is supported by every transport — see the **Feature matrix**
below. Unsupported combinations throw `AgentError("not_supported", …)`.

## Providers + transports

| Provider     | Transports           | Default |
| ------------ | -------------------- | ------- |
| **claude**   | `cli`, `copilot-api` | `cli`   |
| **copilot**  | `sdk`                | `sdk`   |
| **opencode** | `sdk`                | `sdk`   |
| **pi**       | `cli`, `rpc`         | `cli`   |
| **acp()**    | `acp`                | `acp`   |

`copilot()` and `opencode()` use their official SDKs (which themselves spawn helper subprocesses under the hood — see the Sandbox section).
If you need to drive either CLI over the **A**gent **C**lient **P**rotocol
instead, use the generic `acp()` factory:

```ts
import { createAgent, acp } from "agent-sdk-kit";

const agent = createAgent({
  provider: acp({ spawn: ["copilot", "--acp"] }),
});
```

## Feature matrix

What each provider + transport supports. Unsupported options throw
`AgentError("not_supported", …)` rather than silently no-op.

|                       | claude (CLI) | copilot (SDK) | opencode (SDK) | pi (CLI) | acp() |
| --------------------- | :----------: | :-----------: | :------------: | :------: | :---: |
| **Lifecycle**         |              |               |                |          |       |
| `resume`              |      ✅      |      ✅       |       ✅       |    ✅    |  ✅   |
| `resumeSessionAt`     |      ❌      |      ❌       |       ❌       |    ❌    |  ❌   |
| `forkSession`         |      ✅      |      ❌       |       ✅       |   ✅¹    |  ❌   |
| `continue`            |      ✅      |      ❌       |       ❌       |    ❌    |  ❌   |
| `sessionId` (pin)     |      ✅      |      ❌       |       ❌       |    ❌    |  ❌   |
| **Per-call options**  |              |               |                |          |       |
| `systemPrompt`        |     ⚠️¹⁰     |      ✅⁶      |      ✅⁷       |    ✅    |  ⚠️²  |
| `appendSystemPrompt`  |     ✅¹⁰     |      ❌⁸      |      ⚠️⁷       |    ✅    |  ⚠️²  |
| `attachments`         |      ✅      |      ✅       |       ✅       |    ✅    |  ✅   |
| `tools` (custom)      |     ⚠️²      |      ✅       |      ⚠️²       |   ⚠️²    |  ⚠️⁹  |
| `mcpServers`          |      ✅      |      ✅       |       ✅       |    ✅    |  ✅   |
| `abortSignal`         |      ✅      |      ✅       |       ✅       |    ✅    |  ✅   |
| `onPermissionRequest` |      ❌      |      ✅       |       ✅       |    ❌    |  ⚠️³  |
| **Provider features** |              |               |                |          |       |
| `deleteSession`       |      ✅      |      ✅       |       ✅       |    ❌    |  ❌   |
| `sandbox` (nono)      |      ✅      |      ❌⁴      |       ✅       |    ✅    |  ✅⁵  |

Legend: ✅ supported · ❌ throws `not_supported` (or no-op for `deleteSession`) · ⚠️ partial — see footnote.

¹ pi requires opting in via `providerOptions.pi.experimentalFork: true` (legacy alias `providerOptions.pi.fork: true` is also accepted) in addition to `forkSession`.

² Ignored with a one-time `console.warn` (the underlying transport / protocol doesn't expose this surface). For custom tools on transports that warn, expose them via an MCP server instead — or use `copilot()`, which accepts client-side tool registration directly.

³ Best-effort: only honored when the underlying ACP server exposes a matching permission hook.

⁴ Sandbox is not yet wired into the `copilot()` factory. The underlying `@github/copilot-sdk` *does* spawn the Copilot CLI as a subprocess (and exposes `cliPath` / `cliArgs` injection points), so wrapping with `nono run` is feasible — it's just not implemented in the kit today. As a workaround, drive the Copilot CLI over ACP instead: `acp({ spawn: ["copilot", "--acp"], sandbox: { mode: "cwd" } })`.

⁵ Wraps the spawned ACP child with `nono run` per `sandbox` config. See the `Sandbox` section below.

⁶ Copilot SDK applies `systemPrompt` on session **creation** only (mapped to `systemMessage: { mode: "append" }`). Resuming an existing session reuses the prompt baked in at creation; passing a different `systemPrompt` to a resumed session has no effect.

⁷ Opencode's HTTP SDK has a single `body.system` field with no replace-vs-append distinction. The kit collapses `opts.systemPrompt ?? opts.appendSystemPrompt` into that one field, sent on every prompt.

⁸ Copilot SDK exposes only one `systemMessage` slot, which the kit wires to `opts.systemPrompt`. `opts.appendSystemPrompt` is silently dropped — use `opts.systemPrompt` instead.

⁹ Ignored with a one-time `console.warn`. ACP has no client-tool registration in `NewSessionRequest` / `LoadSessionRequest` / `PromptRequest` (verified against the upstream schema). Expose tools via `opts.mcpServers` instead — the kit maps them to ACP's `mcpServers` field.

¹⁰ The Claude Code CLI only exposes `--append-system-prompt` (there is no replace flag). The kit maps **both** `opts.systemPrompt` and `opts.appendSystemPrompt` to that flag, so on claude `systemPrompt` appends to Claude's default rather than replacing it. Both are applied only on `start` / `fork`; resumed sessions reuse the prompt baked in at creation (same as ⁶ for copilot).

## Detect available agents

Check which CLIs are installed and their capabilities:

```ts
import { detectAgents } from "agent-sdk-kit";

const info = await detectAgents();

console.log(info.claude.available); // true if `claude` is on PATH
console.log(info.copilot.version); // "1.0.32"
console.log(info.copilot.capabilities); // { sessionFork: true, acp: true, ... }
```

For a single quick check, use `isProviderAvailable`:

```ts
import { isProviderAvailable, probeProvider, claude, createAgent } from "agent-sdk-kit";

if (await isProviderAvailable("claude")) {
  const agent = createAgent({ provider: claude() });
  // …
}

// Or check a custom binary path:
await isProviderAvailable("opencode", { binPath: "/opt/opencode" });

// Need version + capabilities for one provider only?
const info = await probeProvider("copilot");
```

## Custom tools

Define tools that the agent can call. The `tool()` helper wraps thrown errors and is synchronous. Use `fromZod()` to convert a Zod schema into the JSON Schema it expects on `inputSchema` (uses Zod v4's built-in `z.toJSONSchema`):

```ts
import { z } from "zod";
import { createAgent, copilot, tool, fromZod } from "agent-sdk-kit";

const WeatherInput = z.object({ city: z.string() });

const getWeather = tool("get_weather", {
  description: "Get current weather for a city",
  inputSchema: fromZod(WeatherInput),
  execute: async ({ city }: z.infer<typeof WeatherInput>) => {
    return { city, weather: "62°F and foggy" };
  },
});

const agent = createAgent({
  provider: copilot(),
  tools: { get_weather: getWeather },
});

console.log(await agent.run({ prompt: "What's the weather in San Francisco?" }).text);
```

Custom tools currently require `copilot()`. The opencode SDK does not yet expose client-side tool registration (`opts.tools` is ignored with a warning).

## MCP (Model Context Protocol)

Connect MCP servers to provide additional context:

```ts
import { createAgent, copilot } from "agent-sdk-kit";

const agent = createAgent({
  provider: copilot({ transport: "sdk" }),
  mcpServers: [
    {
      name: "filesystem",
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "./workspace"],
      },
    },
  ],
});
```

## Attachments

Send files, images, or text alongside prompts:

```ts
import { createAgent, claude } from "agent-sdk-kit";

const agent = createAgent({ provider: claude() });

const result = agent.run({
  prompt: "Describe this image",
  options: { attachments: [{ type: "file", path: "./screenshot.png" }] },
});

console.log(await result.text);
```

Supported attachment types:

```ts
type Attachment =
  | { type: "file"; path: string } // File path (relative to cwd)
  | { type: "image"; data: Uint8Array; mimeType: string } // Inline image bytes
  | { type: "image_url"; url: string } // Remote image URL
  | { type: "resource"; name: string; content: string }; // Pasted text/code
```

## Sandbox

Run agents in a sandboxed environment with restricted filesystem and network access (requires [nono](https://github.com/prabirshrestha/nono)):

```ts
import { createAgent, claude } from "agent-sdk-kit";

const agent = createAgent({
  provider: claude({
    sandbox: {
      mode: "cwd", // Restrict to current working directory
    },
  }),
});
```

Sandbox modes (see https://nono.sh/docs/cli/getting_started/quickstart for the underlying flags):

- `"none"` — No sandboxing (default)
- `"cwd"` — `nono run --allow <cwd>` — read+write under the working directory, network allowed
- `"paranoid"` — `nono run --read <cwd> --block-net` — read-only cwd, no network
- `{ nonoProfile: "claude-code" }` — `nono run --profile <name>` (built-in or `~/.config/nono/profiles/<name>.json`)
- `{ nonoProfileFile: "./my-profile.json" }` — installs the JSON file into `~/.config/nono/profiles/` under a random name (since `nono --profile` only resolves names) and unlinks it on dispose
- `SandboxPolicy` object — translated to flag-based invocation (`--allow`, `--read`, `--write`, `--allow-file`, `--read-file`, `--write-file`, `--block-net`, `--allow-domain`). Fields without a CLI equivalent (`filesystem.deny`, `env.strip`, `env.keep`) are ignored with a one-time warning — use a profile file for those.

Sandbox is **not yet wired** into the `copilot()` factory, even though `@github/copilot-sdk` does spawn the Copilot CLI as a subprocess. Until that's plumbed through (it requires overriding `cliPath` / `cliArgs` on the SDK), drive the Copilot CLI over ACP instead:

```ts
import { createAgent, acp } from "agent-sdk-kit";

const agent = createAgent({
  provider: acp({
    spawn: ["copilot", "--acp"],
    sandbox: { mode: "cwd" },
  }),
});
```

`opencode()` already supports `sandbox` directly: its SDK transport spawns `opencode serve` as a subprocess, which the kit wraps with `nono run` when you pass `sandbox`. So `opencode({ binPath: "/path/to/opencode", sandbox: { mode: "cwd" } })` works without the ACP detour.

## Cancellation

Cancel in-flight requests using AbortController:

```ts
import { createAgent, claude } from "agent-sdk-kit";

const controller = new AbortController();
const agent = createAgent({
  provider: claude(),
  abortSignal: controller.signal, // Applies to all calls
});

// Or per-call
const result = agent.run({
  prompt: "Long running task",
  options: { abortSignal: controller.signal },
});

// Cancel after 5 seconds
setTimeout(() => controller.abort(), 5000);
```

Or use the `abort()` method on the result:

```ts
const result = agent.run({ prompt: "Long running task" });
setTimeout(() => result.abort(), 5000);
```

## Deleting sessions

Some providers expose native session deletion:

```ts
const agent = createAgent({ provider: claude() });
const turn = agent.run({ prompt: "hi" });
const sid = await turn.sessionId;
await agent.deleteSession(sid);
```

Support per provider:

| Provider    | Native delete                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| claude      | ✅ removes `~/.claude/.../sessions/<id>.jsonl`                                                             |
| copilot SDK | ✅ via `client.deleteSession()`                                                                            |
| opencode    | ✅ via `client.session.delete()`                                                                           |
| pi          | ❌ throws `AgentError("not_supported", code: "delete_unsupported")`                                        |
| acp()       | ❌ throws `AgentError("not_supported", code: "delete_unsupported")` (ACP does not expose session deletion) |

If you don't know which provider you're targeting, wrap `deleteSession()` in a try/catch and ignore `not_supported` errors.

## Permission requests

Wire an approval handler when using SDK transports that expose tool-use permissions:

```ts
const agent = createAgent({
  provider: copilot({ transport: "sdk" }),
  onPermissionRequest: async (req) => {
    console.log(`Tool wants to run: ${req.toolName}`);
    // Approve once:
    return { decision: "allow" };
    // Or deny with a reason:
    // return { decision: "deny", reason: "not allowed in this session" };
  },
});
```

The handler returns a `PermissionDecision`:

```ts
type PermissionDecision =
  | { decision: "allow"; persist?: boolean }
  | { decision: "deny"; reason?: string };
```

`persist: true` requests a session-scoped approval so the agent won't prompt again for the same tool. Support varies by transport: opencode honors it (maps to its "always"/"once" scope), ACP is best-effort (only honored when the server exposes a matching `allow_always` option), and the Copilot SDK currently ignores it pending SDK support.

Per-call overrides are supported via `agent.run({ prompt, options: { onPermissionRequest } })`.

## ACP — using non-built-in agents

The `acp()` factory wraps any binary that speaks the [Agent Client Protocol](https://agentclientprotocol.com) over stdio:

```ts
import { createAgent, acp } from "agent-sdk-kit";

const agent = createAgent({
  provider: acp({
    spawn: ["my-acp-agent", "--stdio"],
  }),
});

await agent.run({ prompt: "hello" }).text;
```

## License

MIT
