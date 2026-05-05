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
| `@opencode-ai/sdk`                      | optional peer dep    | `opencode({ transport: "sdk" })` (opencode default; uses the v2 client API)                 |
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

// Fork-at-message — branch off a specific prior message UUID. Combine
// `resume + resumeSessionAt + forkSession` to fork the session at that
// message into a new session id (supported on copilot and opencode SDKs;
// see the feature matrix below). Plain `resumeSessionAt` without
// `forkSession` is not supported by any transport — neither SDK exposes
// in-place history truncation.
const turn4 = agent.run({
  prompt: "Try that again, but shorter",
  options: {
    resume: sessionId,
    resumeSessionAt: "<message-uuid>",
    forkSession: true,
  },
});
console.log(await turn4.text);
```

Other lifecycle options on `RunOptions`:

| Option            | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `resume`          | Continue the session with this id                                            |
| `resumeSessionAt` | Resume at a specific message UUID within the session (requires `resume`)     |
| `forkSession`     | Branch the resumed session into a new session id (requires `resume`)         |
| `sessionId`       | Pin a UUID for the new session instead of letting the provider auto-generate |
| `model`           | Per-call model override; takes precedence over the provider's `config.model` |

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
| `resume`              |      ✓       |       ✓       |       ✓        |    ✓     |   ✓   |
| `resumeSessionAt`     |      ✗       |       ✓       |       ✓        |    ✗     |   ✗   |
| `forkSession`         |      ✓       |       ✓       |       ✓        |    ✓     |   ✗   |
| `sessionId` (pin)     |      ✓       |       ✓       |       ✗        |    ✗     |   ✗   |
| **Per-call options**  |              |               |                |          |       |
| `systemPrompt`        |      ~       |       ✓       |       ✓        |    ✓     |   ~   |
| `appendSystemPrompt`  |      ✓       |       ✓       |       ~        |    ✓     |   ~   |
| `model` (override)    |      ✓       |       ✓       |       ✓        |    ✓     |   ~   |
| `attachments`         |      ✓       |       ✓       |       ✓        |    ✓     |   ✓   |
| `tools` (custom)      |      ~       |       ✓       |       ~        |    ~     |   ~   |
| `mcpServers`          |      ✓       |       ✓       |       ✓        |    ~     |   ✓   |
| `abortSignal`         |      ✓       |       ✓       |       ✓        |    ✓     |   ✓   |
| `onPermissionRequest` |      ✗       |       ✓       |       ✓        |    ✗     |   ~   |
| **Provider features** |              |               |                |          |       |
| `deleteSession`       |      ✓       |       ✓       |       ✓        |    ✗     |   ✗   |
| `sandbox` (nono)      |      ✓       |       ✓       |       ✓        |    ✓     |   ✓   |

Legend: **✓** supported · **✗** throws `not_supported` (or no-op for `deleteSession`) · **~** partial — see Notes below.

### Notes

| Cell                             | Note |
| -------------------------------- | ---- |
| pi × `forkSession`               | [1]  |
| copilot × `resumeSessionAt`      | [11] |
| opencode × `resumeSessionAt`     | [11] |
| acp × `model`                    | [12] |
| claude × `systemPrompt`          | [10] |
| claude × `appendSystemPrompt`    | [10] |
| copilot × `systemPrompt`         | [6]  |
| copilot × `appendSystemPrompt`   | [6]  |
| opencode × `systemPrompt`        | [7]  |
| opencode × `appendSystemPrompt`  | [7]  |
| acp × `systemPrompt`             | [2]  |
| acp × `appendSystemPrompt`       | [2]  |
| claude / opencode / pi × `tools` | [2]  |
| acp × `tools`                    | [9]  |
| pi × `mcpServers`                | [8]  |
| acp × `onPermissionRequest`      | [3]  |
| copilot × `sandbox`              | [4]  |
| acp × `sandbox`                  | [5]  |

[1] pi requires opting in via `providerOptions.pi.experimentalFork: true` (legacy alias `providerOptions.pi.fork: true` is also accepted) in addition to `forkSession`.

[2] Ignored with a one-time `console.warn` (the underlying transport / protocol doesn't expose this surface). For custom tools on transports that warn, expose them via an MCP server instead — or use `copilot()`, which accepts client-side tool registration directly.

[3] Best-effort: only honored when the underlying ACP server exposes a matching permission hook.

[4] Sandbox on `copilot()` requires an **explicit `binPath`** for the inner Copilot CLI — the kit overrides `@github/copilot-sdk`'s `cliPath` with `nono` (resolved on PATH) and prepends the wrapper flags via the SDK's `cliArgs` injection point, so the SDK's spawn becomes `nono run …flags -- <binPath> --headless …`. The kit auto-prepends `process.execPath` if `binPath` ends in `.js`. If `nono` isn't installed (and `failIfUnavailable` isn't set), the kit warns and falls back to an unsandboxed spawn.

[5] Wraps the spawned ACP child with `nono run` per `sandbox` config. See the `Sandbox` section below.

[6] Copilot SDK applies system-prompt config on session **creation** only (resuming reuses the prompt baked in at creation). The kit maps `opts.systemPrompt` to `systemMessage: { mode: "replace" }` (drops SDK guardrails — caller owns the full prompt) and `opts.appendSystemPrompt` to `systemMessage: { mode: "append" }` (keeps the SDK foundation and appends). If both are passed, the kit combines them as `replace` content (`systemPrompt + "\n\n" + appendSystemPrompt`) since the SDK only accepts one `systemMessage` slot per session.

[7] Opencode's HTTP SDK has a single `body.system` field with no replace-vs-append distinction. The kit collapses `opts.systemPrompt ?? opts.appendSystemPrompt` into that one field, sent on every prompt.

[8] pi has no MCP configuration surface (`PiConfig` omits `mcpServers` and the pi CLI exposes no flag for MCP server config). `opts.mcpServers` is ignored with a one-time `console.warn`.

[9] Ignored with a one-time `console.warn`. ACP has no client-tool registration in `NewSessionRequest` / `LoadSessionRequest` / `PromptRequest` (verified against the upstream schema). Expose tools via `opts.mcpServers` instead — the kit maps them to ACP's `mcpServers` field.

[10] The Claude Code CLI only exposes `--append-system-prompt` (there is no replace flag). The kit maps **both** `opts.systemPrompt` and `opts.appendSystemPrompt` to that flag, so on claude `systemPrompt` appends to Claude's default rather than replacing it. Both are applied only on `start` / `fork`; resumed sessions reuse the prompt baked in at creation (same as [6] for copilot).

[11] In-place rewind (same session id preserved): copilot calls the experimental session-scoped `session.rpc.history.truncate({ eventId })` RPC after `resumeSession`; opencode calls `POST /session/{id}/revert` with `body.messageID` before the prompt. Combine with `forkSession: true` for fork-at-message instead: copilot routes to `sessions.fork({ toEventId })` and opencode to `POST /session/{id}/fork` with `body.messageID`. The new session id is surfaced as a `session_forked` event with the source id.

[12] ACP's `session/set_model` RPC is marked **UNSTABLE** in the schema ("not part of the spec yet, and may be removed or changed at any point") and is only honored when the agent advertises support via `NewSessionResponse.models`. The kit calls it before the prompt when `opts.model` (or `AcpConfig.model`) is set; if the agent doesn't advertise model selection, the call throws `not_supported`. Format is whatever model id the agent advertises in its `availableModels`.

## Per-call model override

Every transport accepts a per-call `model` on `RunOptions`/`CallOptions` that wins over the provider's construction-time `config.model`:

```ts
const agent = new Agent({ provider: copilot({ model: "claude-sonnet-4" }) });

// Use the configured default
await agent.send("hello").text;

// Override for this turn only
await agent.send("write a haiku", { model: "claude-haiku-4-5" }).text;
```

Format per provider:

| Provider     | `model` value                                                                       |
| ------------ | ----------------------------------------------------------------------------------- |
| **claude**   | model id (e.g. `"claude-sonnet-4-5"`) — passed as `--model`                         |
| **copilot**  | model id passed to the SDK's `createSession` / `resumeSession` config               |
| **opencode** | `"providerID/modelID"` (e.g. `"github-copilot/gpt-4o"`) or just `modelID`           |
| **pi**       | model id — passed as `--model`                                                      |
| **acp()**    | whatever model id the agent advertises (only if it supports `set_model`) — see [12] |

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

Sandbox on `copilot()` requires an **explicit `binPath`** for the inner Copilot CLI — the kit needs a real path on disk to hand to nono. The SDK's bundled-CLI lookup is internal and can't be wrapped:

```ts
import { createAgent, copilot } from "agent-sdk-kit";

const agent = createAgent({
  provider: copilot({
    binPath: "/usr/local/bin/copilot", // required when sandbox is set
    sandbox: { mode: "cwd" },
  }),
});
```

If you'd rather drive the Copilot CLI over ACP instead, that also works:

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

## Testing

```bash
bun test:unit          # fast, hermetic — always runs
bun test:e2e           # gated by env vars (see below)
```

Unit tests have no external dependencies. End-to-end tests spawn real CLIs/SDKs and require both:

1. The CLI/SDK to be installed and authenticated, and
2. An explicit env opt-in (so CI doesn't accidentally hit live APIs).

Set `RUN_E2E=1` to opt every provider in, or one of:

| Env var                  | Enables                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `RUN_E2E_CLAUDE=1`       | `tests/e2e/claude/**` — needs `claude` CLI + Anthropic key  |
| `RUN_E2E_COPILOT_SDK=1`  | `tests/e2e/copilot/**` — needs `@github/copilot-sdk` + auth |
| `RUN_E2E_OPENCODE_SDK=1` | `tests/e2e/opencode/**` — needs `@opencode-ai/sdk` + auth   |
| `RUN_E2E_PI=1`           | `tests/e2e/pi/**` — needs `pi` CLI + provider API key       |
| `RUN_E2E_ACP=1`          | `tests/e2e/acp/**` — defaults to `copilot --acp`            |

E2E tests are organized by provider so each row of the [feature matrix](#feature-matrix) maps to a folder, and each cell maps to a file:

```
tests/e2e/
  _helpers.ts                # env gates, withRetry, fullStream assertions
  claude/        basic | resume | fork | model-override | not-supported
  copilot/       basic | resume | fork | pinned-session | resume-at | model-override
  opencode/      basic | resume | resume-at | model-override | not-supported
  pi/            basic | resume | fork | model-override | not-supported
  acp/           basic | model-override | not-supported
  cross-cutting/ cancellation | mcp-smoke | attachments | custom-tools | sandbox-smoke
```

## License

MIT
