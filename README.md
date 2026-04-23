# seher-ts

TypeScript port of [seher](https://github.com/smartcrabai/seher), a CLI that
waits for an agent's rate limit to reset and then hands execution off to the
highest-priority available coding agent (Claude Code, Codex, OpenCode, ...).

seher-ts is **macOS only**. Usage-limit inspection is fully delegated to the
[CodexBar](https://codexbar.app/) CLI (`codexbar --format json`), so you must
have CodexBar installed and signed-in for provider-based rate-limit checks.

In addition to spawning CLI binaries, seher-ts can drive agents through
first-party SDKs via the shared `SeherSdk` interface:

- `@anthropic-ai/sdk` for Claude agents (`"sdk": "claude"`).
- `@openai/codex-sdk` for Codex agents (`"sdk": "codex"`).

## Install

```sh
bun install
```

## Usage

```sh
# Run via the source entry point
bun run src/index.ts [prompt...]

# Or through the npm script
bun run start
```

## Configuration

seher-ts reads its settings from:

```
~/.config/seher/settings.jsonc
```

Both `settings.json` and `settings.jsonc` are accepted. The loader uses
[`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser), so comments
and trailing commas are supported. The file format is schema-compatible with
the Rust implementation; see [`schemas/settings.schema.json`](./schemas/settings.schema.json)
for the full definition and [`examples/settings.jsonc`](./examples/settings.jsonc)
for a working sample.

### Minimal example

```jsonc
{
	"$schema": "https://raw.githubusercontent.com/seher-ts/seher-ts/main/schemas/settings.schema.json",
	"priority": [
		{ "command": "claude", "model": "high", "priority": 100 },
	],
	"agents": [
		{
			"command": "claude",
			"args": ["--model", "{model}"],
			"models": {
				"high": "opus",
				"medium": "sonnet",
				"low": "haiku",
			},
			"sdk": "claude",
		},
	],
}
```

### SDK selection

Each agent entry may opt into an SDK-backed runner with the `sdk` field:

```jsonc
{
	"agents": [
		// Drive this Claude agent through @anthropic-ai/sdk.
		{ "command": "claude", "sdk": "claude" },

		// Drive this Codex agent through @openai/codex-sdk.
		{ "command": "codex", "sdk": "codex" },

		// Omit `sdk` to spawn the CLI binary directly (default behaviour).
		{ "command": "opencode" },
	],
}
```

Both SDK backends expose the same `SeherSdk` interface so the rest of seher-ts
can treat them interchangeably.

## Known limitations

- **macOS only.** Linux and Windows are not supported at this time.
- **Requires CodexBar.** The `codexbar` CLI must be installed on `$PATH` for
  provider-based rate-limit checks to work.
- The JSONC settings file is format-compatible with the Rust implementation,
  but behavioural parity is still in progress.

## License

Apache-2.0 OR MIT, matching the upstream Rust project. See [`LICENSE`](./LICENSE).
