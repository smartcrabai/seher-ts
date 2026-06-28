/**
 * Shared type definitions for seher-ts (provider/mode/YAML spec).
 */

/** Canonical list of all SDK kinds (runtime source of truth). */
export const ALL_SDK_KINDS = [
	"claude",
	"claude-terminal",
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
 * 一時的なプロバイダ API エラーに対する指数バックオフ再試行ポリシー。
 *
 * プロバイダ単位の設定はルート単位の設定をブロックごと完全に上書きする
 * (Rust 実装 `seher::sdk::config::Config::resolve_retry` と同じ挙動)。
 * 未指定のフィールドは {@link DEFAULT_RETRY_CONFIG} の値にフォールバック。
 */
export interface RetryConfig {
	/** リトライを有効化するか。デフォルト `true`。 */
	enabled?: boolean;
	/** 諦めるまでの最大試行回数。デフォルト `5`。 */
	maxAttempts?: number;
	/** 最初のリトライまでの遅延 (秒)。デフォルト `2`。 */
	initialDelaySecs?: number;
	/** リトライ間の最大遅延 (秒)。デフォルト `60`。 */
	maxDelaySecs?: number;
	/** 遅延に毎回乗算する倍率。デフォルト `2.0`。 */
	multiplier?: number;
	/** HTTP 401/404 もリトライ対象にする (true でオプトイン)。デフォルト `false`。 */
	retryClientErrors?: boolean;
}

/** 全フィールドが具体値に解決済みのリトライ設定。 */
export interface ResolvedRetryConfig {
	enabled: boolean;
	maxAttempts: number;
	initialDelaySecs: number;
	maxDelaySecs: number;
	multiplier: number;
	retryClientErrors: boolean;
}

/** `RetryConfig` のデフォルト値 (Rust 側の `RetryConfig::default` と一致)。 */
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
	/** Per-provider retry policy (ルートの retry をブロックごと上書き)。 */
	retry?: RetryConfig;
	/** Mode -> model entry. Keys include `plan`, `build`, plus user-defined keys. */
	models: Record<string, ModelEntry>;
}

/** Normalized config root. */
export interface Config {
	providers: ProviderEntry[];
	/** Root-level skill discovery defaults (overridden by per-provider). */
	skills?: SkillsConfig;
	/** ルートのリトライポリシー (provider-level retry に上書きされる)。 */
	retry?: RetryConfig;
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
	/** Resolved retry policy (per-provider > root > defaults)。 */
	retry: ResolvedRetryConfig;
}
