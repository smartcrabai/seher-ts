# seher-ts

TypeScript port of [seher](https://github.com/smartcrabai/seher), a CLI that
waits for an agent's rate limit to reset and then hands execution off to the
highest-priority available coding agent (Claude Code, Codex, OpenCode, ...).

seher-ts is **macOS only**. Usage-limit inspection is fully delegated to the
[CodexBar](https://codexbar.app/) CLI (`codexbar --format json`), so you must
have CodexBar installed and signed-in for provider-based rate-limit checks.

In addition to spawning CLI binaries, seher-ts can drive agents through
first-party SDKs via the shared `SeherSdk` interface. The "Tools" column
indicates whether the SDK supports [in-process tool
registration](#in-process-tools):

| SDK setting | Package | Agent | Tools |
|-------------|---------|-------|:-----:|
| `"sdk": "claude"` | `@anthropic-ai/sdk` | Claude | ✅ |
| `"sdk": "copilot"` | `@github/copilot-sdk` | GitHub Copilot | ✅ |
| `"sdk": "kimi"` | `@moonshot-ai/kimi-agent-sdk` | Kimi Code | ✅ |
| `"sdk": "codex"` | `@openai/codex-sdk` | Codex | ❌ |
| `"sdk": "cursor"` | `@cursor/sdk` | Cursor | ❌ |
| `"sdk": "opencode"` | `@opencode-ai/sdk` | OpenCode | ❌ |

## Install

```sh
npm install -g @seher-ts/cli
```

## Usage

```sh
seher [prompt...]
```

## Configuration

seher-ts reads its settings from:

```
~/.config/seher/settings.jsonc
```

Both `settings.json` and `settings.jsonc` are accepted. If both exist,
`settings.jsonc` is loaded first. The loader uses
[`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser), so `//`
and `/* */` comments plus trailing commas are accepted in either filename.
If neither file exists, the default configuration (a single `claude` agent
with no extra arguments) is applied. The file format is schema-compatible
with the Rust implementation; see
[`packages/cli/schemas/settings.schema.json`](./packages/cli/schemas/settings.schema.json)
for the full definition and [`examples/settings.jsonc`](./examples/settings.jsonc)
for a working sample.

### Settings reference

| Field | Type | Description |
|-------|------|-------------|
| `priority` | array | Priority rules used to choose among non-limited agents. |
| `priority[].command` | string | Executable name to match (e.g. `"claude"`, `"codex"`, `"opencode"`). |
| `priority[].provider` | string or null | Provider to match; omitted infers from `command`, `null` matches fallback agents. |
| `priority[].model` | string or null | Model key to match; omitted or `null` matches runs without `--model`. |
| `priority[].priority` | integer | Priority value; higher wins. Unmatched combinations default to `0`. |
| `priority[].weekdays` | array of strings | Weekday ranges in `"start-end"` format (0=Sun, 1=Mon, …, 6=Sat, inclusive). e.g. `["1-5"]` for Mon–Fri. Omit to match any day. |
| `priority[].hours` | array of strings | Hour ranges in `"start-end"` format, half-open `[start, end)`, 0–48. e.g. `["21-27"]` for 21:00–03:00 overnight. Omit to match any hour. |
| `agents` | array | List of agents to use (required). |
| `agents[].command` | string | Executable name (e.g. `"claude"`, `"codex"`, `"opencode"`). |
| `agents[].args` | array of strings | Additional arguments (optional; defaults to `[]`). |
| `agents[].pre_command` | array of strings | Command to run before the agent. First element is the executable, the rest are arguments (optional; defaults to `[]`). |
| `agents[].models` | object or null | Mapping from user-facing model keys (e.g. `"high"`) to backend model identifiers (optional). |
| `agents[].arg_maps` | object | Exact-match mapping from trailing CLI tokens to replacement token arrays (optional; defaults to `{}`). |
| `agents[].env` | object or null | Environment variables to set when running the agent (optional). |
| `agents[].provider` | string or null | Rate-limit provider override (optional, see below). |
| `agents[].openrouter_management_key` | string | Management API key for OpenRouter (required when `provider` is `"openrouter"`). |
| `agents[].glm_api_key` | string | API key for GLM / Zhipu AI (required when `provider` is `"glm"`). |
| `agents[].active` | object or null | Schedule during which the agent is **only** active; disabled outside the window (optional). |
| `agents[].inactive` | object or null | Schedule during which the agent is **disabled**; active outside the window (optional). |
| `agents[].active.weekdays` / `agents[].inactive.weekdays` | array of strings | Same `"start-end"` weekday format as `priority[].weekdays`. |
| `agents[].active.hours` / `agents[].inactive.hours` | array of strings | Same `"start-end"` hour format as `priority[].hours`. |
| `agents[].sdk` | string or null | If set, drive the agent through the named SDK instead of spawning its CLI binary. One of `"claude"`, `"codex"`, `"copilot"`, `"kimi"`, `"opencode"`, `"cursor"`. |

### JSON Schema

To enable editor validation and completion, point your config at the schema
with `$schema`:

```json
{
	"$schema": "https://raw.githubusercontent.com/seher-ts/seher-ts/main/schemas/settings.schema.json",
	"agents": [
		{ "command": "claude" }
	]
}
```

### Full example

```jsonc
{
	"$schema": "https://raw.githubusercontent.com/seher-ts/seher-ts/main/schemas/settings.schema.json",
	"priority": [
		{
			"command": "opencode",
			"provider": "copilot",
			"model": "high",
			"priority": 100,
		},
		{
			"command": "codex",
			"priority": 50,
		},
		{
			// provider: null -> skip provider-based rate-limit checks for this rule.
			"command": "claude",
			"provider": null,
			"model": "medium",
			"priority": 25,
		},
		{
			"command": "claude",
			"model": "low",
			"priority": 10,
		},
	],
	"agents": [
		{
			// Default Claude agent, driven through the Anthropic SDK.
			"command": "claude",
			"args": ["--model", "{model}"],
			"models": {
				"high": "opus",
				"medium": "sonnet",
				"low": "haiku",
				"sonnet": "sonnet",
			},
			"arg_maps": {
				// Expand `--danger` on the CLI tail into a safer explicit flag set.
				"--danger": ["--permission-mode", "bypassPermissions"],
			},
			"env": {
				"CLAUDE_CODE_MAX_TURNS": "100",
			},
			"sdk": "claude",
		},
		{
			"command": "opencode",
			"args": ["--model", "{model}", "--yolo"],
			"models": {
				"high": "github-copilot/gpt-5.4",
				"medium": "github-copilot/gpt-5.4",
				"low": "github-copilot/claude-haiku-4.5",
			},
			"provider": "copilot",
		},
		{
			// Codex agent, driven through the Codex SDK.
			"command": "codex",
			"pre_command": ["git", "pull", "--rebase"],
			"sdk": "codex",
		},
		{
			// Alternate Claude endpoint (DashScope). provider=null treats this
			// as a fallback that is never considered rate-limited.
			"command": "claude",
			"args": ["--model", "{model}"],
			"models": {
				"low": "MiniMax-M2.5",
				"medium": "MiniMax-M2.5",
			},
			"env": {
				"ANTHROPIC_AUTH_TOKEN": "your-api-key-here",
				"ANTHROPIC_BASE_URL": "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
			},
			"provider": null,
		},
	],
}
```

### Templating: `{model}` and `arg_maps`

The `{model}` placeholder in `args` is resolved from the value passed to
`--model`. If the key is present in the agent's `models` map, it is replaced
with the mapped value; otherwise the value is used as-is. When `--model` is
not specified, any argument containing `{model}` is dropped entirely so that
no empty token is forwarded to the agent.

`arg_maps` rewrites each trailing CLI token independently using exact-match
keys. A mapping value can expand a single input token into multiple output
tokens, while unmapped tokens are passed through unchanged. For example, with
the configuration above, `seher --danger "fix bugs"` expands `--danger` into
`--permission-mode bypassPermissions` when the Claude agent is selected.

### `pre_command` and `env`

`pre_command` runs an arbitrary command before the agent is launched. The
first element is the executable and the rest are arguments. It is useful for
tasks like `git pull --rebase` or warming up a local cache. If the command
exits non-zero, the agent run is aborted.

`env` injects environment variables when launching the agent. This is the
standard way to point a stock CLI at a different backend, e.g. routing
`claude` through DashScope by setting `ANTHROPIC_AUTH_TOKEN` and
`ANTHROPIC_BASE_URL`.

### Priority matching

Priority rules match on the combination of `command`, resolved `provider`,
and the `--model` key. If a rule's `provider` is omitted, it is inferred from
`command` (`claude` → `claude`, `codex` → `codex`, `copilot` → `copilot`).
Setting `provider` to `null` matches fallback agents that disable provider
checks. When several agents are not rate-limited, seher selects the highest
`priority`; ties are broken by the order in `agents`.

A rule may also carry `weekdays` and `hours` constraints. `weekdays` is a
list of inclusive `"start-end"` ranges (0=Sun … 6=Sat); `hours` is a list of
half-open `"start-end"` ranges in the 0–48 space (values ≥ 24 wrap to the
next calendar day, so `"21-27"` covers 21:00–03:00). When multiple rules
match the same agent at a given moment, the rule with the most schedule
constraints (`weekdays` + `hours` axes) wins; remaining ties fall back to the
first matching rule.

```jsonc
{
	"priority": [
		// Default daytime priority.
		{ "command": "claude", "priority": 100 },
		// Boost codex on weekday nights (21:00–03:00).
		{ "command": "codex", "priority": 200, "weekdays": ["1-5"], "hours": ["21-27"] },
	],
}
```

### Per-agent schedules (`active` / `inactive`)

Individual agents can be enabled or disabled based on time-of-day and
day-of-week:

- `active`: when set, the agent is **only** selectable during the specified
  schedule; disabled outside it.
- `inactive`: when set, the agent is disabled during the specified schedule;
  active at all other times.
- Setting both `active` and `inactive` on the same agent is rejected at load
  time. Each rule must specify at least one of `weekdays` or `hours`.

Both fields use the same `"start-end"` range format as
`priority[].weekdays` / `priority[].hours`. Agents disabled by their
schedule are transparently excluded, so seher falls back to the next
eligible agent.

```jsonc
{
	"agents": [
		// Only use this agent during weekday business hours (Mon–Fri, 09:00–18:00).
		{
			"command": "claude",
			"active": {
				"weekdays": ["1-5"],
				"hours": ["9-18"],
			},
		},
		// Never use this agent overnight (21:00–03:00).
		{
			"command": "codex",
			"inactive": {
				"hours": ["21-27"],
			},
		},
	],
}
```

### Providers and rate-limit checks

The `provider` field controls how seher decides whether an agent is
currently rate-limited. If omitted, the provider is inferred from `command`
(`claude` → claude.ai, `codex` → chatgpt.com, `copilot` → github.com).
Setting it to `null` disables rate-limit checking for that agent (useful for
fallback endpoints). Setting it to a string overrides the inferred provider.

In seher-ts, all provider-based rate-limit inspection is delegated to the
[CodexBar](https://codexbar.app/) CLI (`codexbar --format json`), so the
`codexbar` binary must be on `$PATH` and signed in for the relevant
accounts. seher-ts does **not** read browser cookies directly. Provider
strings recognised by CodexBar (e.g. `"claude"`, `"codex"`, `"copilot"`,
`"cursor"`, `"openrouter"`, `"glm"`, `"opencode-go"`) can be set explicitly
on an agent. The `openrouter_management_key` and `glm_api_key` fields are
schema-validated when `provider` is `"openrouter"` / `"glm"` so that the
keys can be forwarded to CodexBar where required.

### SDK selection

Each agent entry may opt into an SDK-backed runner with the `sdk` field.
SDK-backed agents skip the CLI binary entirely and call the provider's
first-party SDK in-process:

```jsonc
{
	"agents": [
		// Drive this Claude agent through @anthropic-ai/sdk.
		{ "command": "claude", "sdk": "claude" },

		// Drive this Codex agent through @openai/codex-sdk.
		{ "command": "codex", "sdk": "codex" },

		// Drive this Copilot agent through @github/copilot-sdk.
		{ "command": "copilot", "sdk": "copilot" },

		// Drive this Kimi agent through @moonshot-ai/kimi-agent-sdk.
		{ "command": "kimi", "sdk": "kimi" },

		// Drive this OpenCode agent through @opencode-ai/sdk.
		{ "command": "opencode", "sdk": "opencode" },

		// Drive this Cursor agent through @cursor/sdk.
		{ "command": "cursor-agent", "sdk": "cursor" },

		// Omit `sdk` to spawn the CLI binary directly (default behaviour).
		{ "command": "opencode" },
	],
}
```

All SDK backends expose the same `SeherSdk` interface, so the rest of
seher-ts treats them interchangeably with spawned CLIs.

## SDK (programmatic API)

In addition to the `seher` CLI, the same agent-resolution and SDK-dispatch
logic is exposed as a library package, `@seher-ts/sdk`. It loads the same
`~/.config/seher/settings.jsonc`, performs the same CodexBar rate-limit
checks (sleeping until reset by default), and dispatches the call to the
first-party SDK of the resolved agent in-process.

### Install

```sh
bun add @seher-ts/sdk
# or: npm install @seher-ts/sdk
```

### Auto-resolve an agent from settings

The default entry mirrors the CLI: `SeherSDK` consults your settings file,
applies priority rules, checks rate limits via CodexBar, and only then
dispatches to the chosen agent's first-party SDK.

```ts
import { SeherSDK } from "@seher-ts/sdk";

const sdk = new SeherSDK();
const result = await sdk.run({ prompt: "Hello!" });
console.log(result.kind, result.text);
```

`run()` returns a `SeherRunResult` with the resolved provider `kind`
(`"claude" | "codex" | "copilot" | "kimi" | "opencode" | "cursor"`), the
assistant text, and the provider-specific `raw` payload. `stream()`
yields incremental `SeherStreamChunk`s as the agent produces output:

```ts
for await (const chunk of sdk.stream({ prompt: "Write a haiku" })) {
	process.stdout.write(chunk.delta);
}
```

The resolved agent must have an `sdk` field set in settings (one of
`"claude"`, `"codex"`, `"copilot"`, `"kimi"`, `"opencode"`, `"cursor"`);
CLI-only agents are not callable from `SeherSDK` and will throw.

### Filter and option overrides

```ts
new SeherSDK({
	command: "claude",     // restrict to a specific agent command
	provider: "anthropic", // restrict to a specific provider
	model: "high",         // restrict to agents declaring this model key
	configPath: "/path/to/settings.jsonc",
	noWait: true,          // throw AllAgentsLimitedError instead of sleeping
	maxRescans: 0,         // give up after the first rate-limit scan
});
```

Per-call options forwarded through `run()` / `stream()` override the
prompt, model, system prompt, and max tokens:

```ts
await sdk.run({
	prompt: "Refactor this function",
	model: "sonnet",
	systemPrompt: "You are a senior TypeScript reviewer.",
	maxTokens: 4096,
});
```

`resolved()` forces resolution and returns the chosen `kind` plus the
source agent. `reset()` drops any cached resolution so the next call
re-runs CodexBar checks.

### Skip auto-resolution with `kind`

If you already know which provider to use, set `kind` to bypass settings
loading and CodexBar entirely:

```ts
const sdk = new SeherSDK({
	kind: "claude",
	apiKey: process.env.ANTHROPIC_API_KEY,
});
await sdk.run({ prompt: "Hello!" });
```

`SeherSDKConfig` is the union of every provider's config (`apiKey`,
`baseURL`, `defaultModel`, `permissionMode`, `cwd`, `gitHubToken`,
`sandboxMode`, `approvalPolicy`, …), so only the fields relevant to the
selected provider are read.

### In-process tools

Runtime tool registration is supported by a subset of SDKs:

- ✅ Supported: `claude`, `copilot`, `kimi`.
- ❌ Not supported: `codex`, `cursor`, `opencode`.

Tools are defined as `SeherTool`s with a `zod` `ZodObject` schema and a
handler that returns a `string`:

```ts
import { z } from "zod";
import { SeherSDK, type SeherTool } from "@seher-ts/sdk";

const tools: SeherTool[] = [
	{
		name: "get_weather",
		description: "Look up the current weather for a city.",
		parameters: z.object({ city: z.string() }),
		handler: async ({ city }) => `It's sunny in ${city}.`,
	},
];

const sdk = new SeherSDK({ tools });
await sdk.run({ prompt: "What's the weather in Tokyo?" });
```

Codex, Cursor, and OpenCode do not support runtime tool registration. If
auto-resolution selects one of those, `SeherSDK` logs a warning and
silently ignores `tools`; agents that cannot carry tools are also
filtered out of the candidate set when `tools` is non-empty. To guarantee
tool support, narrow the resolver with `command`, `provider`, or `kind`.

### Per-provider entry points

If you only need one provider, the package also exposes per-provider
entry points that re-export each backend class directly, skipping the
resolver:

```ts
import { ClaudeSDK } from "@seher-ts/sdk/claude";
import { CodexSDK } from "@seher-ts/sdk/codex";
import { CopilotSDK } from "@seher-ts/sdk/copilot";
import { KimiSDK } from "@seher-ts/sdk/kimi";
import { OpencodeSDK } from "@seher-ts/sdk/opencode";
import { CursorSDK } from "@seher-ts/sdk/cursor";
import { SeherSDK } from "@seher-ts/sdk/seher"; // same as the root entry
```

All of them implement the shared `SeherSDKInstance` interface
(`kind`, `run`, `stream`).

### Lower-level resolution helpers

For finer-grained control, the package also exports the underlying
resolver and rate-limit primitives so callers can plug in their own
dispatch:

```ts
import {
	AllAgentsLimitedError,
	NoMatchingAgentError,
	checkLimit,
	filterAgents,
	loadSettings,
	resolveAgent,
	sleepUntil,
	sortByPriority,
} from "@seher-ts/sdk";

const settings = await loadSettings();
const agent = await resolveAgent({ settings, command: "claude" });
```

`resolveAgent()` throws `NoMatchingAgentError` when filters exclude all
agents, and `AllAgentsLimitedError` (carrying `minReset: Date`) when every
candidate is rate-limited and `noWait` is set.

## Known limitations

- **macOS only.** Linux and Windows are not supported at this time.
- **Requires CodexBar.** The `codexbar` CLI must be installed on `$PATH` for
  provider-based rate-limit checks to work.
- The JSONC settings file is format-compatible with the Rust implementation,
  but behavioural parity is still in progress.

