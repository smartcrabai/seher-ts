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
| `claude-terminal` | `claude-terminal` | Claude Code CLI driven via tmux |
| `codex` | `codex` | `@openai/codex-sdk` |
| `cursor` | `cursor` | `@cursor/sdk` |
| `opencodego` | `opencode` | `@opencode-ai/sdk` |
| `copilot` | `copilot` | `@github/copilot-sdk` |
| `kimi` | `kimi` | `@moonshot-ai/kimi-agent-sdk` |
| — | `pi` | `@earendil-works/pi-coding-agent` |

The `claude-terminal` SDK drives the Claude Code CLI as an interactive
tmux session and captures responses by polling its JSONL transcript
under `~/.claude/projects/`. It shares the same CodexBar account quota
as `claude` (i.e. `claude-terminal` candidates are checked against the
`claude` usage entry).

Paste-detection (the step that waits for the pasted prompt to appear
in the TUI before submitting Enter) is robust against long Japanese /
CJK prompts: it normalizes ANSI escapes, NFC-normalizes code points,
selects prefix and suffix needles by terminal cell width (not raw
character count), strips trailing Markdown decoration / punctuation
from the suffix needle, and accepts a collapsed-paste citation as an
alternative signal. The wait has its own short timeout
(`pasteVisibleTimeoutMs`, default 90s) so a stuck detection returns
control to the caller for retry instead of blocking the whole
response timeout.

Provider keys outside this table must declare `sdk: <kind>` and an `api`
block. Use `sdk: pi` with any provider key to drive the pi.dev agent.
There is no default provider mapping for pi; setting `sdk: pi` is the only
way to opt in.

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
| `-t, --timeout <ms>` | Per-run timeout in milliseconds. Default is the SDK default — usually none, except Copilot (60_000). On timeout the CLI exits 1 with a `TimeoutError` message; in-flight provider work is **not** aborted. |
| `-q, --quiet` | Suppress informational output. |
| `-h, --help` / `-v, --version` | Print help / version and exit. |

## Configuration

seher-ts reads its YAML config from (in priority order):

1. `-c <path>`
2. `$SEHER_CONFIG`
3. `~/.config/seher/config.yaml`

If no file exists, the default empty config is used.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/smartcrabai/seher-ts/main/packages/cli/schemas/config.schema.json

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
| `sdk` | `"claude" \| "claude-terminal" \| "codex" \| "copilot" \| "kimi" \| "opencode" \| "cursor" \| "pi"` | Required when the resolved provider name is outside the built-in set; optional otherwise (defaults from the table above). |
| `priority` | number | Provider-level shorthand. Used when a model entry omits its own priority. |
| `api.key` | string | Mapped to the SDK's native key field (e.g. `ANTHROPIC_API_KEY`, `gitHubToken`, …). |
| `api.endpoint` | string | Mapped to the SDK's native base URL field (e.g. `ANTHROPIC_BASE_URL`, OpenCode `baseURL`, …). |
| `skills.includeClaude` | boolean | Per-provider override of the top-level `skills.includeClaude`. |
| `retry` | object | Per-provider retry policy override. Replaces the root `retry` block as a whole — fields are **not** merged individually. Missing fields fall back to the hard-coded defaults. |
| `models` | map | Mode key (`plan` / `build` / custom) → `{ model: string, priority?: number }`. A bare string is shorthand for `{ model: <string> }`. |

### Top-level options

| Field | Type | Notes |
|---|---|---|
| `skills.includeClaude` | boolean | When true (default), auto-inject `~/.claude/skills` and `<cwd>/.claude/skills` into the underlying agent's skill paths for SDK kinds that do not natively read Claude-style skills (currently `pi`). |
| `retry` | object | Default retry policy applied to every provider that does not specify its own `retry` block. See the [Retry policy](#retry-policy) section below. |

### Retry policy

`retry` configures an exponential-backoff retry policy for transient provider
API errors. It may be specified at the top level and/or per-provider; when a
provider defines its own `retry` block it **replaces** the root block as a
whole rather than merging fields. Missing fields fall back to the defaults
shown below.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether retries are enabled. |
| `maxAttempts` | integer (≥ 1) | `5` | Maximum number of attempts before giving up. |
| `initialDelaySecs` | integer (≥ 0) | `2` | Delay before the first retry, in seconds. |
| `maxDelaySecs` | integer (≥ 0) | `60` | Cap on the delay between retries, in seconds. |
| `multiplier` | number (≥ 1.0) | `2.0` | Factor applied to the delay after each retry. |
| `retryClientErrors` | boolean | `false` | Opt in to also retry HTTP 401/404 (some providers return these during transient outages). |

```yaml
# Root-level default applied to every provider that doesn't override it.
retry:
  maxAttempts: 5
  initialDelaySecs: 2
  multiplier: 2.0

providers:
  claude:
    # claude uses the root retry block.
    models:
      build: sonnet-4.6

  zai:
    sdk: claude
    api: { key: sk-za-xxxxx, endpoint: https://api.zai.example.com }
    # Provider-level retry REPLACES the root block — fields not listed
    # here fall back to defaults (NOT to the root values above).
    retry:
      enabled: false
    models:
      build: glm-5.1
```

The retry policy is currently surfaced on `ResolvedAgent.retry` but is not
yet wired into the SDK dispatch path — it will start applying once the
streaming/retry layer lands.

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
| `timeoutMs` | Default per-run timeout (ms). Per-call override: `SeherRunOptions.timeoutMs` on `run()` / `stream()`. On expiry, the SDK rejects with `TimeoutError` (importable from `@seher-ts/sdk`); in-flight provider work is **not** aborted. |
| `apiKey`, `baseURL`, `gitHubToken`, … | Per-provider config knobs (forwarded when relevant to the resolved kind). |

`resolved()` forces resolution and returns the chosen `{ kind, agent }`.
`reset()` drops the cached resolution so the next call re-runs CodexBar
checks (used by `plan` mode to re-resolve under `build`).

### Per-provider entry points

```ts
import { ClaudeSDK } from "@seher-ts/sdk/claude";
import { ClaudeTerminalSDK } from "@seher-ts/sdk/claude-terminal";
import { CodexSDK } from "@seher-ts/sdk/codex";
import { CopilotSDK } from "@seher-ts/sdk/copilot";
import { CursorSDK } from "@seher-ts/sdk/cursor";
import { KimiSDK } from "@seher-ts/sdk/kimi";
import { OpencodeSDK } from "@seher-ts/sdk/opencode";
import { PiSDK } from "@seher-ts/sdk/pi";
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
modeKey, api?, env, skills, retry }`. `provider` is the resolved provider
name (used by CodexBar / `-p`), defaulting to the YAML map key when no
`provider` field is set on the entry. `skills` and `retry` are the
per-candidate resolved view of the [Retry policy](#retry-policy) and
skill auto-discovery (per-provider > root > defaults).

## Known limitations

- **macOS only.** Linux/Windows are not supported.
- **CodexBar required** for rate-limit checks on provider keys that
  CodexBar tracks. Other keys are treated as always available.
