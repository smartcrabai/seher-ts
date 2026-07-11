import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/**
 * Shared type definitions for seher-ts (provider/mode/YAML spec).
 */

/** Canonical list of all SDK kinds (runtime source of truth). */
export const ALL_SDK_KINDS = [
	"claude",
	"claude-terminal",
	"claude-headless",
	"codex",
	"copilot",
	"kimi",
	"opencode",
	"cursor",
	"pi",
] as const;

/** Which provider SDK to drive. */
export type SdkKind = (typeof ALL_SDK_KINDS)[number];

/** Per-mode model entry inside a `ProviderEntry`. */
export interface ModelEntry {
	model: string;
	priority?: number;
	/**
	 * Reasoning effort for this model entry. Resolved with `model > provider >
	 * root` precedence (see `ProviderEntry.effort` / `Config.effort` and
	 * `resolveEffort` in `sdk/resolve.ts`, matching the Rust side's
	 * `Config::resolve_effort`). The resolved value takes precedence over a
	 * `:level` suffix on `model` (e.g. `anthropic/claude-opus-4-5:high`), which
	 * is only used as a fallback when no effort is configured at any level.
	 */
	effort?: EffortLevel;
}

/** Provider-level API config (forwarded to the underlying SDK). */
export interface ProviderApi {
	key?: string;
	endpoint?: string;
}

/**
 * Opt-in / opt-out flags for skill auto-discovery applied to SDK kinds that
 * do not natively read Claude-style skills (currently `pi`). Set at the
 * top-level or per-provider in the YAML config.
 */
export interface SkillsConfig {
	/**
	 * When true (default), seher-ts auto-injects `~/.claude/skills` and
	 * `<cwd>/.claude/skills` into the underlying agent's skill paths.
	 */
	includeClaude?: boolean;
}

/** Skills config with all fields resolved to concrete values. */
export interface ResolvedSkillsConfig {
	includeClaude: boolean;
}

/**
 * Exponential backoff retry policy for transient provider API errors.
 *
 * A provider-level setting completely overrides the root-level block
 * (same behavior as the Rust implementation's
 * `seher::sdk::config::Config::resolve_retry`).
 * Unspecified fields fall back to the values in {@link DEFAULT_RETRY_CONFIG}.
 */
export interface RetryConfig {
	/** Whether to enable retries. Defaults to `true`. */
	enabled?: boolean;
	/** Maximum number of attempts before giving up. Defaults to `5`, minimum `1`. */
	maxAttempts?: number;
	/** Delay before the first retry (seconds). Defaults to `2`. */
	initialDelaySecs?: number;
	/** Maximum delay between retries (seconds). Defaults to `60`. */
	maxDelaySecs?: number;
	/** Multiplier applied to the delay on each retry. Defaults to `2.0`, minimum `1.0`. */
	multiplier?: number;
	/** Whether to also retry HTTP 401/404 (opt-in via `true`). Defaults to `false`. */
	retryClientErrors?: boolean;
}

/** Retry config with all fields resolved to concrete values. */
export interface ResolvedRetryConfig {
	enabled: boolean;
	maxAttempts: number;
	initialDelaySecs: number;
	maxDelaySecs: number;
	multiplier: number;
	retryClientErrors: boolean;
}

/** Default values for `RetryConfig` (matches the Rust side's `RetryConfig::default`). */
export const DEFAULT_RETRY_CONFIG: ResolvedRetryConfig = {
	enabled: true,
	maxAttempts: 5,
	initialDelaySecs: 2,
	maxDelaySecs: 60,
	multiplier: 2.0,
	retryClientErrors: false,
};

/** A single provider in the YAML `providers` map (after normalization). */
export interface ProviderEntry {
	/** YAML map key as written in the config (used as a stable label). */
	key: string;
	/** Insertion order in the original YAML map (for stable tiebreaks). */
	order: number;
	/**
	 * Resolved provider name. Equals the explicit `provider` field when
	 * specified in YAML, otherwise falls back to `key`. Drives the built-in
	 * SDK default lookup, the CodexBar usage query, and the `-p` filter.
	 */
	provider: string;
	/** Underlying SDK to drive this provider with. */
	sdk: SdkKind;
	/** Provider-level priority shorthand (used when a model lacks its own). */
	priority?: number;
	/** Extra API config forwarded to the SDK constructor. */
	api?: ProviderApi;
	/** Per-provider skill discovery overrides (takes precedence over root). */
	skills?: SkillsConfig;
	/**
	 * Per-provider retry policy override. When defined, it replaces the
	 * root setting entirely (no per-field merging).
	 */
	retry?: RetryConfig;
	/**
	 * Provider-level reasoning effort default. Overridden by a model entry's
	 * own `effort` when present (see `resolveEffort` in `sdk/resolve.ts`).
	 */
	effort?: EffortLevel;
	/**
	 * Provider-level extra environment variables. Merged with the root-level
	 * `env` on a per-key basis, with this taking precedence (see `resolveEnv`
	 * in `sdk/resolve.ts`, matching the Rust side's `Config::resolve_env`).
	 */
	env?: Record<string, string>;
	/** Mode -> model entry. Keys include `plan`, `build`, plus user-defined keys. */
	models: Record<string, ModelEntry>;
}

/** Normalized config root. */
export interface Config {
	providers: ProviderEntry[];
	/** Root-level skill discovery defaults (overridden by per-provider). */
	skills?: SkillsConfig;
	/**
	 * Root-level retry policy. Ignored entirely when a provider's `retry`
	 * is defined (no per-field merging).
	 */
	retry?: RetryConfig;
	/**
	 * Root-level reasoning effort default, applied when neither the provider
	 * nor the model entry specifies one (see `resolveEffort` in `sdk/resolve.ts`).
	 */
	effort?: EffortLevel;
	/**
	 * Root-level extra environment variables applied to every provider.
	 * Provider-level `env` keys override these on a per-key basis (see
	 * `resolveEnv` in `sdk/resolve.ts`).
	 */
	env?: Record<string, string>;
}

/**
 * Whether a provider is currently rate-limited.
 *
 * `resetTime` is the moment the limit is expected to reset (local time).
 */
export type AgentLimit =
	| { kind: "not_limited" }
	| { kind: "limited"; resetTime: Date };

/** Output of `resolveAgent`: which provider/model to use. */
export interface ResolvedAgent {
	/** Resolved provider name (e.g., "claude", "zai"). */
	provider: string;
	/** SDK kind to instantiate. */
	kind: SdkKind;
	/** Concrete model id passed to the SDK. */
	modelId: string;
	/** Mode key used during resolution (plan / build / custom). */
	modeKey: string;
	/** API config to forward (apiKey / baseURL etc). */
	api?: ProviderApi;
	/** Env vars to forward to provider SDKs that accept env passthrough. */
	env: Record<string, string>;
	/** Skill discovery flags resolved from per-provider > root > defaults. */
	skills: ResolvedSkillsConfig;
	/** Resolved retry policy (per-provider > root > defaults). */
	retry: ResolvedRetryConfig;
	/**
	 * Reasoning effort resolved with `model > provider > root` precedence
	 * (see `resolveEffort` in `sdk/resolve.ts`). `undefined` when none of the
	 * three specify one. Backends fall further back to a `:level` suffix on
	 * the model id when this is unset.
	 */
	effort?: EffortLevel;
}
