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
 * Exponential-backoff retry policy for transient provider API errors.
 *
 * 設定は root と provider の二段構成。provider-level が定義されている場合は
 * root の値を一切引き継がず provider 単体で defaults にフォールバックする
 * (個別フィールドのマージはしない)。
 */
export interface RetryConfig {
	/** 再試行を有効にするか (default: true)。 */
	enabled?: boolean;
	/** 諦めるまでの最大試行回数 (default: 5、最低 1)。 */
	maxAttempts?: number;
	/** 初回リトライ前の待機秒数 (default: 2)。 */
	initialDelaySecs?: number;
	/** リトライ間の上限待機秒数 (default: 60)。 */
	maxDelaySecs?: number;
	/** 毎回 delay に掛ける倍率 (default: 2.0、最低 1.0)。 */
	multiplier?: number;
	/** HTTP 401/404 などのクライアントエラーもリトライ対象にするか (default: false)。 */
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
	 * Per-provider retry policy override. 定義されている場合は root を置換
	 * (フィールド単位のマージはしない)。
	 */
	retry?: RetryConfig;
	/** Mode -> model entry. Keys include `plan`, `build`, plus user-defined keys. */
	models: Record<string, ModelEntry>;
}

/** Normalized config root. */
export interface Config {
	providers: ProviderEntry[];
	/** Root-level skill discovery defaults (overridden by per-provider). */
	skills?: SkillsConfig;
	/**
	 * Root-level retry policy defaults. provider の `retry` が定義されている
	 * 場合は丸ごと無視される (フィールド単位のマージはしない)。
	 */
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
	/** Retry policy resolved from per-provider > root > defaults. */
	retry: ResolvedRetryConfig;
}
