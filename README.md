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
| `claude-headless` | `claude-headless` | `claude -p` subprocess |
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
`claude` usage entry) *unless* the entry's resolved `env` sets
`ANTHROPIC_BASE_URL` to a non-empty (post-trim) value — that points the
`claude` CLI at a third-party Anthropic-compatible endpoint (e.g. kimi,
zai), so the entry is checked under its own provider's CodexBar quota
instead.

The `claude-headless` SDK is a lightweight alternative: it runs
`claude -p "<prompt>"` as a one-shot subprocess and returns the captured
stdout. There is no tmux pane and no transcript polling — useful when
you just want a single-shot completion from the Claude CLI. It also
shares the `claude` CodexBar account quota, with the same
`ANTHROPIC_BASE_URL` override exception as `claude-terminal`.

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

Provider keys outside this table must declare `sdk: <kind>`. They also
need an `api` block unless the selected SDK can resolve credentials from
its own native config. In particular, `sdk: pi` needs no `api` block by
default because the pi.dev agent reads its own auth store / environment.
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
  plan-mode provider (captured internally, **not** streamed to stdout),
  opens it in `$EDITOR` (vim) for you to review/edit, then re-resolves
  under build mode and runs the approved plan as the next prompt, whose
  output streams to stdout as usual. Saving an empty file cancels the
  run. Because `plan` must launch an editor, it requires a foreground
  terminal; running without one (e.g. inside an agent harness with
  redirected stdio) exits with an explicit
  `seher is not running in the foreground terminal` error instead of
  being suspended by `SIGTTOU`/`SIGTTIN`.
- With no positional prompt and a TTY, the CLI opens `$EDITOR` so you can
  type a prompt. Piping into stdin is also supported.

### Options

| Flag | Description |
|---|---|
| `-p, --provider <name>` | Force a specific provider (matches the resolved `provider` name; defaults to the YAML map key when `provider` is omitted). |
| `-m, --model <key>` | Use this model key (e.g. `low`) instead of the default plan/build key. Only providers that define the key are eligible. |
| `-c, --config <path>` | Path to YAML config (defaults to `$SEHER_CONFIG` or `~/.config/seher/config.yaml`). |
| `-t, --timeout <ms>` | Per-run timeout in milliseconds. Default is the SDK default — usually none, except Copilot (60_000). On timeout the CLI exits 1 with a `TimeoutError` message; in-flight provider work is **not** aborted. |
| `--effort <level>` | Reasoning effort level (`low`/`medium`/`high`/`xhigh`/`max`) forwarded to `claude`/`claude-headless`/`claude-terminal` (as `--effort`), `pi` (mapped to a thinking level), and `codex`/`copilot` (via their native reasoning-effort fields). Ignored by `kimi`/`cursor`/`opencode`. Takes precedence over any `effort` resolved from `config.yaml` (`model` > `provider` > root), which in turn takes precedence over a `:level` suffix on the model id. |
| `--cwd <dir>` | Working directory for the agent. Canonicalized on receipt (must exist); multi-turn sessions are bound to it so the same `--cwd` must be passed when resuming. |
| `-r, --resume <id>` | Resume a prior session by id (printed as `session: <id>` on a previous run). Pass the same `--cwd` used to create it. |
| `-q, --quiet` | Suppress informational output. |
| `--show-resolution` | Show which provider/model/SDK would be selected and exit (no prompt required). Candidates are listed on stderr (with `[LIMITED until ...]` / `[probe error]` tags from codexbar and, when set, `effort=<level>`); the winner (including resolved `effort`, with `--effort` taking precedence when given) is printed as a single-line JSON object on stdout. Combine with `-p` to filter candidates or `-m` to override the mode key. |
| `-h, --help` / `-v, --version` | Print help / version and exit. |

### Multi-turn sessions

Every run through a session-owning backend (`claude`, `claude-terminal`, `pi`)
is a persistent session that a follow-up run can continue:

- A fresh run prints `session: <id>` to **stderr** (stdout carries only the
  assistant text, so piping stays safe). `--quiet` suppresses the print.
- Sessions are bound to the working directory. Pass `-r/--resume <id>` together
  with the **same `--cwd`** used to create the session (`--cwd` is canonicalized
  up front so symlinked/relative forms of the same directory resolve identically).
- `--resume` is validated against `^[A-Za-z0-9_-]+$` and rejects path separators
  or other junk so a malicious id cannot escape the per-cwd session directory.
- On resume, the underlying SDK loads the prior conversation (Claude uses
  `claude --resume <id>`; pi opens the on-disk session JSONL). If the resolver
  would pick a different backend than the one that owns the session, pass
  `--provider` to force the matching one.

```sh
# Turn 1 -- fresh session; the id is printed on stderr.
seher --cwd /path/to/project "implement the feature"   # stderr: session: <uuid>

# Turn 2 -- continue the conversation with the same cwd and the printed id.
seher --cwd /path/to/project -r <uuid> "now add tests"
```

#### `--show-resolution` examples

```bash
# Show which provider/model/SDK would be selected (dry run)
seher --show-resolution
seher --show-resolution -m plan
seher --show-resolution -p codex
```

The winner JSON has the shape `{"provider": "...", "model": "...", "sdk": "...", "mode": "...", "effort"?: "..."}` (`effort` is omitted when neither `--effort` nor `config.yaml` resolve one). When all candidates are rate-limited (`AllAgentsLimitedError`) or no providers match (`NoMatchingAgentError`) the CLI exits 1 with the error message on stderr.

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
| `sdk` | `"claude" \| "claude-terminal" \| "claude-headless" \| "codex" \| "copilot" \| "kimi" \| "opencode" \| "cursor" \| "pi"` | Required when the resolved provider name is outside the built-in set; optional otherwise (defaults from the table above). |
| `priority` | number | Provider-level shorthand. Used when a model entry omits its own priority. |
| `api.key` | string | Mapped to the SDK's native key field (e.g. `ANTHROPIC_API_KEY`, `gitHubToken`, …). Optional for `sdk: pi` unless you want a runtime override. |
| `api.endpoint` | string | Mapped to the SDK's native base URL field (e.g. `ANTHROPIC_BASE_URL`, OpenCode `baseURL`, …). |
| `skills.includeClaude` | boolean | Per-provider override of the top-level `skills.includeClaude`. |
| `retry` | object | Per-provider retry policy override. Replaces the root `retry` block as a whole — fields are **not** merged individually. Missing fields fall back to the hard-coded defaults. See [Retry policy](#retry-policy). |
| `effort` | string | Provider-level reasoning effort default: `low`, `medium`, `high`, `xhigh`, or `max`. Overridden by a model entry's own `effort`; falls back to the top-level `effort` when unset. See [Model entries](#model-entries). |
| `env` | map (`string → string`) | Extra environment variables injected when this provider executes. Merged with the top-level `env` on a per-key basis, with these values taking precedence. See [Environment variables](#environment-variables). |
| `models` | map | Mode key (`plan` / `build` / custom) → `{ model: string, priority?: number, effort?: string }`. A bare string is shorthand for `{ model: <string> }`. |

### Top-level options

| Field | Type | Notes |
|---|---|---|
| `skills.includeClaude` | boolean | When true (default), auto-inject `~/.claude/skills` and `<cwd>/.claude/skills` into the underlying agent's skill paths for SDK kinds that do not natively read Claude-style skills (currently `pi`). |
| `retry` | object | Default retry policy applied to every provider that does not specify its own `retry` block. See the [Retry policy](#retry-policy) section below. |
| `effort` | string | Default reasoning effort (`low` / `medium` / `high` / `xhigh` / `max`) used as the final fallback when neither the provider nor the model entry specifies one. See [Model entries](#model-entries). |
| `env` | map (`string → string`) | Extra environment variables applied to every provider as the base layer, overridden per-key by a provider's own `env`. See [Environment variables](#environment-variables). |

### Retry policy

Transient provider API errors (`HTTP 429 / 500 / 502 / 503 / 504`) are
retried against the **same provider** with exponential backoff before the
limit-retry loop kicks in and switches to another provider. `LimitError`
(rate / usage limit) bypasses the transient-retry loop and goes straight
to the provider-switch path so the next available provider can take over
without waiting.

Configure at the root or per-provider; provider-level settings replace
the root block entirely rather than merging individual fields. Missing
fields fall back to the defaults shown below.

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | Whether retries are enabled. |
| `maxAttempts` | integer (≥ 1) | `5` | Maximum number of attempts before giving up (initial attempt + up to `maxAttempts - 1` retries). |
| `initialDelaySecs` | integer (≥ 0) | `2` | Delay before the first retry, in seconds. |
| `maxDelaySecs` | integer (≥ 0) | `60` | Cap on the delay between retries, in seconds. |
| `multiplier` | number (≥ 1.0) | `2.0` | Factor applied to the delay after each retry. Clamped to `1.0` to avoid decay. |
| `retryClientErrors` | boolean | `false` | Opt in to also retry HTTP 401/404 (some providers return these during transient outages). |

```yaml
# Root-level default applied to every provider that doesn't override it.
retry:
  enabled: true
  maxAttempts: 5
  initialDelaySecs: 2
  maxDelaySecs: 60
  multiplier: 2.0
  retryClientErrors: false

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

### Environment variables

Extra environment variables can be set at the root and/or per-provider.
Unlike `retry`, this **is** merged per-key: the root `env` is applied
first, then the provider's own `env` overrides matching keys on top of
it (a provider that sets no `env` still gets the root's).

```yaml
env:                          # applied to every provider (optional)
  HTTP_PROXY: http://corp-proxy:8080

providers:
  zai:
    sdk: claude
    api: { key: sk-za-xxxxx, endpoint: https://api.zai.example.com }
    env:
      # Keeps HTTP_PROXY from the root above; NO_PROXY is added on top,
      # and any key also present in the root would be overridden here.
      NO_PROXY: internal.zai.example.com
    models:
      build: glm-5.1
```

Per-SDK behavior:

- **claude / claude-headless / claude-terminal / codex / copilot / kimi**:
  forwarded to the spawned/underlying process's environment. For `codex`,
  since `CodexOptions.env` (when set) does **not** inherit `process.env`,
  seher-ts always merges `{ ...process.env, ...env }` before passing it
  through, so the rest of the environment (`PATH`, etc.) is preserved.
- **pi**: pi runs in-process (no subprocess), so there is no per-call env
  to pass — instead, seher-ts temporarily mutates `process.env` for the
  duration of the `run()` / `stream()` call and restores the prior values
  (or removes the key if it was previously unset) once it completes,
  whether it succeeds or throws. Concurrent `pi` calls across the process
  are serialized around this window so their env mutations never
  interleave.
- **cursor / opencode**: **not supported** — neither SDK exposes an env
  injection point for its default (local) execution mode in the current
  version. An `env` set at any level is dropped with a warning (same
  handling as an unsupported `effort`/`tools`).

Env keys containing `=` or a NUL byte are rejected at config-load time
(these would corrupt the `KEY=VALUE` serialization used when handing
environment variables to a child process).

### Model entries

A `models` value is either a bare model-id string or an object
`{ model, priority, effort }`:

```yaml
models:
  build: anthropic/claude-sonnet-4-5          # bare string
  plan: { model: anthropic/claude-opus-4-5, priority: 10 }   # full form
  high: { model: anthropic/claude-opus-4-5, effort: xhigh }  # explicit effort
  fast: anthropic/claude-opus-4-5:high        # with a thinking-suffix effort
```

The **model id** uses a `provider/model` shape. The segment before the
first `/` is passed to the SDK as the provider (e.g. `anthropic`,
`openai`); the rest is the model name. A model id without a `/` is
passed through with no explicit provider.

**Reasoning effort** can be set explicitly, via CLI, or inferred from
the model id, in this precedence order (highest wins):

1. `--effort <level>` on the CLI (or the SDK's `effortLevel` /
   `RunForResolvedOptions.effort` at the API level).
2. The model entry's own `effort` field.
3. The provider-level `effort`.
4. The root-level `effort`.
5. A trailing `:level` suffix on the model id (e.g.
   `anthropic/claude-opus-4-5:high`, `opus-4.7:medium`) -- recognized
   for **every** `sdk` (`pi`, `claude`, `claude-headless`,
   `claude-terminal`), not just `pi`. The suffix accepts pi's broader
   thinking-level vocabulary: `off`, `minimal`, `low`, `medium`,
   `high`, `xhigh`, `max`, plus the aliases `none` / `0`, `min` / `1`,
   `med` / `2`, `3`, `4`.

All five forms accept the same `low` / `medium` / `high` / `xhigh` /
`max` vocabulary once resolved to an `EffortLevel` (the suffix form
additionally recognizes pi's `off`/aliases, which then map as
described below). A suffix that doesn't parse as any of the above
stays part of the model name, so OpenRouter-style variants like
`openrouter/meta-llama/llama-3.1-8b-instruct:free` keep working.

Once resolved, the effort level is forwarded differently per SDK:

- **claude / claude-headless / claude-terminal**: forwarded as
  `claude --effort <level>` / the Claude Agent SDK's `Options.effort`.
  `off` / `none` / `0` have no equivalent (the `claude` CLI's
  `--effort` flag has no "off" tier), so no override is applied and
  the SDK's own default is used, though the suffix is still stripped
  from the model id either way.
- **pi**: mapped to pi's native thinking level via `effortToThinking`
  (`low`/`medium`/`high`/`xhigh` map 1:1; `max` rounds down to pi's
  highest tier, `xhigh`, since pi has no `max` tier).
- **codex**: forwarded to `ThreadOptions.modelReasoningEffort`
  (`low`/`medium`/`high`/`xhigh` map 1:1; `max` rounds down to `xhigh`.
  Codex's own type also has a `minimal` tier, but nothing here ever
  produces it since `EffortLevel` has no equivalent).
- **copilot**: forwarded to `SessionConfig.reasoningEffort`
  (`low`/`medium`/`high`/`xhigh`; `max` rounds down to `xhigh`). Only
  effective for models where `capabilities.supports.reasoningEffort`
  is true per the copilot-sdk docs.
- **kimi / cursor / opencode**: **not wired** -- no reliable native
  reasoning-effort hook is exposed for these SDKs. An `effort` set at any
  level is ignored with a `console.warn` (same handling as an
  unsupported `env`/`tools`).

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
   tried — unless that 100% window's `resetsAt` has already passed, in
   which case it's treated as a stale snapshot of an already-reset window
   (not an active limit) and the candidate still wins. If CodexBar has no
   entry for the key (or the binary is missing or fails to spawn), the
   candidate is treated as always available.
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
| `tools` | In-process tools forwarded to providers that support them (Claude, Copilot, Kimi). All other candidates (Codex, Cursor, OpenCode, Pi, Claude Terminal, Claude Headless) are filtered out during resolution; a warning is emitted (and the tools dropped) if a non-supporting kind is selected explicitly via `kind`. |
| `timeoutMs` | Default per-run timeout (ms). Per-call override: `SeherRunOptions.timeoutMs` on `run()` / `stream()`. On expiry, the SDK rejects with `TimeoutError` (importable from `@seher-ts/sdk`); in-flight provider work is **not** aborted. |
| `retryOnLimit` | When true (and `kind` is unset), auto-fail over to the next non-limited provider on `LimitError`. The CLI sets this by default. |
| `onLimitRetry`, `onAllLimited`, `onLimitWaitTick` | Hooks for the limit-retry loop (provider switch, all-limited polling). |
| `onTransientRetry` | Hook fired right before the SDK retries the **same provider** for a transient HTTP error (`HTTP 429 / 500 / 502 / 503 / 504`, plus `401 / 404` when `retryClientErrors` is true). Receives `{ provider, attempt, maxAttempts, message, delayMs }`. Disabled when `retry.enabled === false` on the resolved agent. |
| `cwd` | Working directory forwarded to the resolved SDK. For `claude` / `claude-terminal` / `cursor` / `pi` this becomes the agent's `cwd`; for `kimi` it is also mapped to `workDir`. Multi-turn sessions are bound to this directory. |
| `apiKey`, `baseURL`, `gitHubToken`, … | Per-provider config knobs (forwarded when relevant to the resolved kind). |

`SeherRunOptions` additionally accepts:

| Field | Notes |
|---|---|
| `prompt` | The user prompt. |
| `model` | Per-call model override. |
| `systemPrompt` | Per-call system prompt. |
| `timeoutMs` | Per-call timeout override. |
| `resume` | Session id to resume. Forwarded as `--resume <id>` for Claude-based backends, and as a pre-loaded `SessionManager` for `pi`. SDKs that don't own sessions silently ignore it. |

`SeherRunResult` includes `text`, `kind`, `raw`, and an optional `sessionId`
set by SDKs that own multi-turn sessions (`claude`, `claude-terminal`, `pi`).
Use it to persist the id between turns; the same value is also available via
`sdk.lastSessionId()` after `run()` / `stream()`.

`resolved()` forces resolution and returns the chosen `{ kind, agent }`.
`reset()` drops the cached resolution so the next call re-runs CodexBar
checks (used by `plan` mode to re-resolve under `build`).

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
modeKey, api?, env, skills, retry }`. `provider` is the resolved provider
name (used by CodexBar / `-p`), defaulting to the YAML map key when no
`provider` field is set on the entry. `skills` and `retry` are the
per-candidate resolved view of the [Retry policy](#retry-policy) and
skill auto-discovery (per-provider > root > defaults). `retry` drives the
SDK's same-provider transient-HTTP retry loop.

## Auto-loaded skills

When a provider runs through the in-process `pi` SDK, seher-ts automatically
injects the following skill directories into the underlying agent's resource
loader:

1. `~/.agents/skills` — **always** loaded, regardless of any configuration.
   This matches the hard-coded behaviour of the Rust [`seher`](https://github.com/smartcrabai/seher)
   reference implementation and gives a single user-wide skills directory
   that works out of the box across agent runners.
2. `~/.claude/skills` and `<cwd>/.claude/skills` — loaded when
   `skills.includeClaude` (per-provider, or the top-level default) is not
   set to `false`. This opts into the agentskills.io standard layout shared
   with Claude Code.

Skill paths that do not exist on disk are silently ignored (the underlying
`DefaultResourceLoader` records them as diagnostics but does not throw).
To populate a skill, drop a directory containing a `SKILL.md` file under
one of the paths above; it will be picked up on the next session start.

### Dispatch API (resolved agent direct execution)

When you already hold a `ResolvedAgent` (e.g., you ran `resolveAgent`
manually) and want to skip the YAML re-resolution that `SeherSDK`
performs, the lower-level `dispatch` API forwards directly to the right
provider SDK:

```ts
import {
  resolveAgent,
  runForResolved,
  streamForResolved,
  DispatchToolsNotSupportedError,
} from "@seher-ts/sdk";

const agent = await resolveAgent({ modeKey: "build" });

// One-shot
const result = await runForResolved(agent, { prompt: "hello" });

// Streaming
for await (const chunk of streamForResolved(agent, { prompt: "hello" })) {
  process.stdout.write(chunk.delta);
}
```

Passing non-empty `tools` to a kind that cannot honor them (anything
other than `claude` / `copilot` / `kimi`) throws a
`DispatchToolsNotSupportedError` synchronously from `runForResolved` and
at iteration time from `streamForResolved`.

## Known limitations

- **macOS only.** Linux/Windows are not supported.
- **CodexBar required** for rate-limit checks on provider keys that
  CodexBar tracks. Other keys are treated as always available.
