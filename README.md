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
| `claude-headless` | `claude-headless` | `claude -p` driven as a subprocess (no tmux) |
| `codex` | `codex` | `@openai/codex-sdk` |
| `cursor` | `cursor` | `@cursor/sdk` |
| `opencodego` | `opencode` | `@opencode-ai/sdk` |
| `copilot` | `copilot` | `@github/copilot-sdk` |
| `kimi` | `kimi` | `@moonshot-ai/kimi-agent-sdk` |
| — | `pi` | `@earendil-works/pi-coding-agent` |

The `claude-terminal` SDK drives the Claude Code CLI as an interactive
tmux session and captures responses by polling its JSONL transcript
under `~/.claude/projects/`. The `claude-headless` SDK is a simpler
runner that spawns `claude -p` as a subprocess and reads its
stream-json output; it needs no tmux and supports no in-process tools.
All three claude backends (`claude`, `claude-terminal`,
`claude-headless`) share the same CodexBar account quota: their
candidates are checked against the `claude` usage entry.

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
  next prompt. The plan model is instructed to output *only* the plan and
  touch no files; its output is captured internally rather than streamed
  to stdout, and the captured text is what gets seeded into the editor.
  Saving an empty file cancels the run. Because `plan` must launch an
  editor, it requires a foreground terminal: running with stdin or
  stdout redirected exits with an explicit error instead of being
  suspended.
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
| `--show-resolution` | Show which provider / model / SDK would be selected and exit (no prompt required). Each candidate and its limit state is listed on **stderr**; the winning resolution is printed as JSON on **stdout**. |
| `--cwd <dir>` | Working directory for the agent. Canonicalized on receipt (so symlinked or relative forms of the same directory resolve identically); must exist. Multi-turn sessions are bound to it. |
| `-r, --resume <id>` | Resume a prior session by id (printed as `session: <id>` on stderr by a previous fresh run). Pass the same `--cwd` used to create the session. |
| `-h, --help` / `-v, --version` | Print help / version and exit. |

### Multi-turn sessions

A run against any of the three claude-family backends (`claude`,
`claude-terminal`, `claude-headless`) is a persistent session that a
follow-up run can continue:

- A fresh run prints `session: <id>` to **stderr** (stdout carries only
  the assistant text, so piping stays safe).
- Sessions are bound to the working directory. Pass `-r/--resume <id>`
  together with the **same `--cwd`** used to create the session
  (`--cwd` is canonicalized up front so equivalent paths match).
- On resume, seher probes the on-disk session storage to find the
  backend that owns the id and **pins** it: the retry-on-limit provider
  switch is disabled (a session id is meaningless to a different
  backend), and a missing session is a hard error. If the resolver
  would pick a different backend (e.g. the owner is rate-limited), pass
  `--provider` to force the matching one.
- The three claude-family backends share the underlying
  `claude --resume <id>` contract, so a session created by one can be
  resumed by another as long as `--cwd` matches.
- The `pi` SDK does **not** currently support resume in seher-ts: pi
  runs are one-shot and the resolver never emits a session id for
  them. Pass a fresh prompt instead.

## Configuration

seher-ts reads its YAML config from (in priority order):

1. `-c <path>`
2. `$SEHER_CONFIG`
3. `~/.config/seher/config.yaml`

If no file exists, the default empty config is used.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/smartcrabai/seher-ts/main/packages/cli/schemas/config.schema.json

# Top-level skill discovery defaults (optional).
skills:
  includeClaude: true

# Top-level retry policy defaults (optional). A provider-level `retry`
# block replaces these settings entirely rather than merging fields.
retry:
  enabled: true
  maxAttempts: 5
  initialDelaySecs: 2
  maxDelaySecs: 60
  multiplier: 2.0

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

  claude-fast:
    sdk: claude-headless   # runs `claude -p` as a subprocess (no tmux)
    priority: 2
    models:
      build: sonnet-4.6

  zai:
    sdk: claude            # required for non-builtin provider keys
    api:
      key: sk-za-xxxxxxxxxxxxx
      endpoint: https://api.zai.example.com
    skills:
      includeClaude: false # provider-level override of the top-level default
    models:
      plan: glm-5.1
      build: glm-5.1

  kimi:
    # Some providers occasionally return HTTP 401/404 during transient
    # outages. Opt in to retrying those status codes.
    retry:
      enabled: true
      retryClientErrors: true
    models:
      build: kimi/k1
```

A working sample lives at [`examples/config.yaml`](./examples/config.yaml)
and the JSON Schema at
[`packages/cli/schemas/config.schema.json`](./packages/cli/schemas/config.schema.json).

### Provider entry shape

| Field | Type | Notes |
|---|---|---|
| `provider` | string | Resolved provider name. Defaults to the YAML map key. Drives the built-in SDK default lookup, the CodexBar usage query, and the `-p` filter. Use this to share a CodexBar pool between multiple entries (e.g. two `provider: claude` entries with different priorities/models). |
| `sdk` | `"claude" \| "claude-terminal" \| "claude-headless" \| "codex" \| "copilot" \| "kimi" \| "opencode" \| "cursor" \| "pi"` | Required when the resolved provider name is outside the built-in set; optional otherwise (defaults from the table above). |
| `priority` | number | Provider-level shorthand. Used when a model entry omits its own priority. |
| `api.key` | string | Mapped to the SDK's native key field (e.g. `ANTHROPIC_API_KEY`, `gitHubToken`, …). |
| `api.endpoint` | string | Mapped to the SDK's native base URL field (e.g. `ANTHROPIC_BASE_URL`, OpenCode `baseURL`, …). |
| `skills` | object | Per-provider override of the top-level `skills` block (see *Auto-loaded skills*). |
| `retry` | object | Per-provider override of the top-level `retry` block. The provider block replaces the top-level one entirely rather than merging fields (see *Retry policy*). |
| `models` | map | Mode key (`plan` / `build` / custom) → `{ model: string, priority?: number }`. A bare string is shorthand for `{ model: <string> }`. |

### Model entries

A `models` value is either a bare model-id string or an object
`{ model, priority }`:

```yaml
models:
  build: sonnet-4.6                       # bare string
  plan:  { model: opus-4.7, priority: 10 }
  high:  opus-4.7:high                    # with a thinking level
```

The **model id** uses a `provider/model` shape when you want to pin
the upstream provider explicitly: the segment before the first `/` is
passed to pi as the provider (e.g. `anthropic`, `openai`,
`openrouter`), and the rest is the model name. A model id without a
`/` is forwarded as the model with no explicit provider, and pi falls
back to its own defaults.

A trailing `:` suffix on the model name selects pi's **thinking
level**: `model:level` (e.g. `opus-4.7:high`,
`anthropic/claude-opus-4-5:medium`). Recognized levels are `off`,
`minimal`, `low`, `medium`, `high`, and `xhigh`, plus the aliases pi
accepts: `none`/`0`, `min`, `1`, `med`/`2`, `3`, `4`. A suffix that is
not a recognized level stays part of the model name, so OpenRouter-style
variants like `openrouter/meta-llama/llama-3.1-8b-instruct:free` keep
working. The level only applies to pi execution; with the `claude`,
`claude-terminal`, and `claude-headless` SDKs a recognized suffix is
stripped before being sent to the CLI. Without a suffix, pi's default
(no extended thinking) is used.

### Retry policy

Retries are applied to transient provider-side API errors (5xx, network
faults, …) in both the SDK and CLI paths. Retry settings can be
declared at the top level and / or per provider; a provider block
**replaces** the top-level one rather than merging field-by-field.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. Set to `false` to disable retries entirely. |
| `maxAttempts` | integer | `5` | Maximum number of attempts (including the first try). |
| `initialDelaySecs` | integer | `2` | Delay before the first retry, in seconds. |
| `maxDelaySecs` | integer | `60` | Upper bound on the delay between retries. |
| `multiplier` | number | `2.0` | Backoff multiplier applied after each retry. |
| `retryClientErrors` | boolean | `false` | Opt in to retrying HTTP 401/404 errors that some providers (notably Kimi) return during transient outages. |

### Auto-loaded skills

When a provider uses the in-process `pi` SDK, seher-ts automatically
loads any agent skills it finds on disk and appends them to the
system prompt. No configuration is required; place each skill in its
own directory with a `SKILL.md` file and it is picked up on the next
run.

The search paths are:

- `~/.agents/skills` — always scanned (hard-coded, matches the Rust
  build).
- `~/.claude/skills` and `<cwd>/.claude/skills` — scanned when
  `skills.includeClaude` is `true` (the default).

Set `skills.includeClaude: false` to disable Claude-skill discovery
either globally or for a single provider. The setting only affects
the pi runner; the `claude`, `claude-terminal`, and `claude-headless`
backends already pick up `~/.claude/skills` themselves via the
underlying CLI.

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
| `tools` | In-process tools forwarded to providers that support them (Claude, Copilot, Kimi). Codex / Cursor / OpenCode / `claude-terminal` / `claude-headless` candidates are filtered out and a warning is emitted if a non-supporting kind is selected. |
| `timeoutMs` | Default per-run timeout (ms). Per-call override: `SeherRunOptions.timeoutMs` on `run()` / `stream()`. On expiry, the SDK rejects with `TimeoutError` (importable from `@seher-ts/sdk`); in-flight provider work is **not** aborted. |
| `apiKey`, `baseURL`, `gitHubToken`, … | Per-provider config knobs (forwarded when relevant to the resolved kind). |

`resolved()` forces resolution and returns the chosen `{ kind, agent }`.
`reset()` drops the cached resolution so the next call re-runs CodexBar
checks (used by `plan` mode to re-resolve under `build`).

### Running against an already-resolved agent

When you have a `ResolvedAgent` in hand (e.g. from a previous
`resolveAgent` call, or because you want to skip the limit check
entirely) you can drive a single backend through `runForResolved` /
`streamForResolved` without going back through the resolver:

```ts
import {
  loadConfig,
  resolveAgent,
  runForResolved,
  streamForResolved,
} from "@seher-ts/sdk";

const config = await loadConfig();
const agent = await resolveAgent({ config, modeKey: "build" });

for await (const chunk of streamForResolved(agent, { prompt: "Hi!" })) {
  process.stdout.write(chunk.delta);
}
```

### Per-provider entry points

```ts
import { ClaudeSDK } from "@seher-ts/sdk/claude";
import { ClaudeTerminalSDK } from "@seher-ts/sdk/claude-terminal";
import { ClaudeHeadlessSDK } from "@seher-ts/sdk/claude-headless";
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
modeKey, api?, env }`. `provider` is the resolved provider name (used
by CodexBar / `-p`), defaulting to the YAML map key when no `provider`
field is set on the entry.

## Known limitations

- **macOS only.** Linux/Windows are not supported.
- **CodexBar required** for rate-limit checks on provider keys that
  CodexBar tracks. Other keys are treated as always available.
- **`pi` does not support resume.** Multi-turn `--resume` only works
  against the three claude-family backends (`claude`,
  `claude-terminal`, `claude-headless`).
