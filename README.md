# seher-ts

TypeScript implementation of seher: a CLI and SDK that picks the
highest-priority **available** coding agent (Claude, Codex, Cursor, Copilot,
Kimi, OpenCode, …) and runs your prompt through that provider's first-party
SDK.

seher-ts is **macOS only**. Usage-limit inspection is delegated to the
[CodexBar](https://codexbar.app/) CLI (`codexbar usage --format json`), so
you must have CodexBar installed and signed-in for provider-based
rate-limit checks. Providers that CodexBar does not know about
(community / self-hosted endpoints) are treated as always available.

| Provider key | SDK | Package |
|---|---|---|
| `claude` | `claude` | `@anthropic-ai/claude-agent-sdk` |
| `codex` | `codex` | `@openai/codex-sdk` |
| `cursor` | `cursor` | `@cursor/sdk` |
| `opencodego` | `opencode` | `@opencode-ai/sdk` |
| `copilot` | `copilot` | `@github/copilot-sdk` |
| `kimi` | `kimi` | `@moonshot-ai/kimi-agent-sdk` |

Provider keys outside this table must declare `sdk: <kind>` and an `api`
block.

## Install

```sh
npm install -g @seher-ts/cli
```

## Usage

```
seher [plan|build] [options] [prompt...]
```

- `build` (the default subcommand) streams the prompt through the resolved
  agent. Permissions are auto-allowed (yolo).
- `plan` first generates an implementation plan with the resolved
  plan-mode provider, opens it in `$EDITOR` (vim) for you to review/edit,
  then re-resolves under build mode and runs the approved plan as the
  next prompt. Saving an empty file cancels the run.
- With no positional prompt and a TTY, the CLI opens `$EDITOR` so you can
  type a prompt. Piping into stdin is also supported.

### Options

| Flag | Description |
|---|---|
| `-p, --provider <name>` | Force a specific provider (matches the resolved `provider` name; defaults to the YAML map key when `provider` is omitted). |
| `-m, --model <key>` | Use this model key (e.g. `low`) instead of the default plan/build key. Only providers that define the key are eligible. |
| `-c, --config <path>` | Path to YAML config (defaults to `$SEHER_CONFIG` or `~/.config/seher/config.yaml`). |
| `-q, --quiet` | Suppress informational output. |
| `-h, --help` / `-v, --version` | Print help / version and exit. |

## Configuration

seher-ts reads its YAML config from (in priority order):

1. `-c <path>`
2. `$SEHER_CONFIG`
3. `~/.config/seher/config.yaml`

If no file exists, the default empty config is used.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/smartcrabai/seher-ts/main/schemas/config.schema.json

providers:
  codex:
    models:
      plan:  { model: gpt-5.5, priority: 5 }
      build: { model: gpt-5.5, priority: 4 }

  claude:
    priority: 3            # provider-level priority shorthand
    models:
      plan:  opus-4.7      # string shorthand = { model: opus-4.7 }
      build: sonnet-4.6
      low:   haiku-4.5

  zai:
    sdk: claude            # required for non-builtin provider keys
    api:
      key: sk-za-xxxxxxxxxxxxx
      endpoint: https://api.zai.example.com
    models:
      plan: glm-5.1
      build: glm-5.1
```

A working sample lives at [`examples/config.yaml`](./examples/config.yaml)
and the JSON Schema at
[`packages/cli/schemas/config.schema.json`](./packages/cli/schemas/config.schema.json).

### Provider entry shape

| Field | Type | Notes |
|---|---|---|
| `provider` | string | Resolved provider name. Defaults to the YAML map key. Drives the built-in SDK default lookup, the CodexBar usage query, and the `-p` filter. Use this to share a CodexBar pool between multiple entries (e.g. two `provider: claude` entries with different priorities/models). |
| `sdk` | `"claude" \| "codex" \| "copilot" \| "kimi" \| "opencode" \| "cursor"` | Required when the resolved provider name is outside the built-in set; optional otherwise (defaults from the table above). |
| `priority` | number | Provider-level shorthand. Used when a model entry omits its own priority. |
| `api.key` | string | Mapped to the SDK's native key field (e.g. `ANTHROPIC_API_KEY`, `gitHubToken`, …). |
| `api.endpoint` | string | Mapped to the SDK's native base URL field (e.g. `ANTHROPIC_BASE_URL`, OpenCode `baseURL`, …). |
| `models` | map | Mode key (`plan` / `build` / custom) → `{ model: string, priority?: number }`. A bare string is shorthand for `{ model: <string> }`. |

### Selection logic

1. The CLI mode (`plan` or `build`, or the `-m <key>` override) determines
   the model key.
2. Only providers that define `models.<key>` are candidates.
3. Each candidate's effective priority =
   `models.<key>.priority ?? provider.priority ?? 0`.
4. Candidates are sorted by priority descending; the YAML insertion order
   is the tiebreaker.
5. For each candidate (in order), CodexBar is queried by provider key.
   If usage is < 100% the candidate wins. If 100% the next candidate is
   tried. If CodexBar has no entry for the key (or the binary is missing
   or fails to spawn), the candidate is treated as always available.
6. If every candidate is at 100%, the resolver sleeps until the earliest
   reset and rescans once.

## SDK (programmatic API)

The same logic is exposed as a library, `@seher-ts/sdk`.

```sh
bun add @seher-ts/sdk
```

```ts
import { SeherSDK } from "@seher-ts/sdk";

const sdk = new SeherSDK({ mode: "build" });
for await (const chunk of sdk.stream({ prompt: "Hello!" })) {
  process.stdout.write(chunk.delta);
}
```

`SeherSDKOptions`:

| Field | Notes |
|---|---|
| `mode` | Mode key (`"plan"` / `"build"` / custom). Defaults to `"build"`. |
| `provider` | Force a specific provider (matches the resolved `provider` name; defaults to the YAML map key when `provider` is omitted). |
| `configPath` | Override the YAML config path. |
| `noWait` | Throw `AllAgentsLimitedError` instead of sleeping. |
| `kind` | Skip resolution and use this SDK kind directly. |
| `tools` | In-process tools forwarded to providers that support them (Claude, Copilot, Kimi). Codex / Cursor / OpenCode candidates are filtered out and a warning is emitted if a non-supporting kind is selected. |
| `apiKey`, `baseURL`, `gitHubToken`, … | Per-provider config knobs (forwarded when relevant to the resolved kind). |

`resolved()` forces resolution and returns the chosen `{ kind, agent }`.
`reset()` drops the cached resolution so the next call re-runs CodexBar
checks (used by `plan` mode to re-resolve under `build`).

### Per-provider entry points

```ts
import { ClaudeSDK } from "@seher-ts/sdk/claude";
import { CodexSDK } from "@seher-ts/sdk/codex";
import { CopilotSDK } from "@seher-ts/sdk/copilot";
import { CursorSDK } from "@seher-ts/sdk/cursor";
import { KimiSDK } from "@seher-ts/sdk/kimi";
import { OpencodeSDK } from "@seher-ts/sdk/opencode";
```

All implement the shared `SeherSDKInstance` interface (`kind`, `run`,
`stream`).

### Lower-level helpers

```ts
import {
  loadConfig,
  resolveAgent,
  AllAgentsLimitedError,
  NoMatchingAgentError,
} from "@seher-ts/sdk";

const config = await loadConfig();
const agent = await resolveAgent({ config, modeKey: "build" });
```

`resolveAgent` returns `ResolvedAgent` with `{ provider, kind, modelId,
modeKey, api?, env }`. `provider` is the resolved provider name (used
by CodexBar / `-p`), defaulting to the YAML map key when no `provider`
field is set on the entry.

## Known limitations

- **macOS only.** Linux/Windows are not supported.
- **CodexBar required** for rate-limit checks on provider keys that
  CodexBar tracks. Other keys are treated as always available.
