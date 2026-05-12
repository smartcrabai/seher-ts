import type { ResolvedAgent, SdkKind } from "../types.ts";
import { ALL_SDK_KINDS } from "../types.ts";
import { ClaudeSDK, type ClaudeSDKConfig } from "./claude.ts";
import { CodexSDK, type CodexSDKConfig } from "./codex.ts";
import { CopilotSDK, type CopilotSDKConfig } from "./copilot.ts";
import { CursorSDK, type CursorSDKConfig } from "./cursor.ts";
import { LimitError } from "./errors.ts";
import { KimiSDK, type KimiSDKConfig } from "./kimi.ts";
import { OpencodeSDK, type OpencodeSDKConfig } from "./opencode.ts";
import {
	AllAgentsLimitedError,
	NoMatchingAgentError,
	pollForAgent,
	type ResolveAgentOptions,
	resolveAgent,
	TOOL_SUPPORTING_KINDS,
} from "./resolve.ts";
import type {
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

/** SDKs that don't support in-process JS tool registration (derived from TOOL_SUPPORTING_KINDS). */
const NO_TOOL_SUPPORT: ReadonlySet<SdkKind> = new Set<SdkKind>(
	ALL_SDK_KINDS.filter((k) => !TOOL_SUPPORTING_KINDS.has(k)),
);

/** SDKs whose underlying lib does not accept env passthrough. */
const NO_ENV_SUPPORT: ReadonlySet<SdkKind> = new Set<SdkKind>([
	"codex",
	"copilot",
	"cursor",
	"opencode",
]);

function hasTools(config: SeherSDKConfig): boolean {
	return config.tools !== undefined && config.tools.length > 0;
}

function requiresToolsSupport(opts: SeherSDKOptions): boolean {
	return opts.kind === undefined && hasTools(opts);
}

function stripTools(config: SeherSDKConfig): SeherSDKConfig {
	const { tools: _tools, ...rest } = config;
	return rest;
}

function stripEnv(config: SeherSDKConfig): SeherSDKConfig {
	const { env: _env, ...rest } = config;
	return rest;
}

export type SeherSDKConfig = ClaudeSDKConfig &
	CodexSDKConfig &
	CopilotSDKConfig &
	CursorSDKConfig &
	KimiSDKConfig &
	OpencodeSDKConfig;

export interface LimitRetryInfo {
	provider: string;
	resetAt?: Date;
}

export interface SeherSDKOptions extends SeherSDKConfig {
	/** When provided, skip auto-resolution and use this provider directly. */
	kind?: SdkKind;
	/** Mode key to resolve (`plan` / `build` / custom). Default: `build`. */
	mode?: string;
	/** Force a specific provider key (e.g., "claude"). */
	provider?: string;
	/** Override the YAML config path. */
	configPath?: string;
	/** Throw `AllAgentsLimitedError` instead of sleeping. */
	noWait?: boolean;
	/** Max rescans after sleep. Defaults to 1. */
	maxRescans?: number;
	/**
	 * When true (and `kind` is not explicitly set), automatically fail over to
	 * the next non-limited provider on `LimitError`, and poll CodexBar every
	 * `limitPollIntervalMs` once all providers are limited.
	 */
	retryOnLimit?: boolean;
	/** Polling interval when all providers are limited. Defaults to 60_000. */
	limitPollIntervalMs?: number;
	/** Called when a provider runtime hit a limit and retry will pick another. */
	onLimitRetry?: (info: LimitRetryInfo) => void;
	/** Called when entering the "all providers limited" polling loop. */
	onAllLimited?: () => void;
	/** Called once per scan attempt while waiting for any provider to recover. */
	onLimitWaitTick?: (attempt: number) => void;
	/** Cancellation signal for the indefinite poll wait. */
	limitWaitSignal?: AbortSignal;
	/** Advanced: override individual collaborators used during resolution (tests). */
	resolveOverrides?: Pick<
		ResolveAgentOptions,
		| "loadConfig"
		| "checkLimit"
		| "sleepUntil"
		| "now"
		| "config"
		| "quiet"
		| "onSleep"
	>;
}

/**
 * Apply provider-level api/env to the underlying SDK config in the right
 * field per SDK kind. Caller-supplied opts take precedence.
 */
function applyResolvedAgent(
	kind: SdkKind,
	base: SeherSDKConfig,
	agent: ResolvedAgent,
): SeherSDKConfig {
	const out: SeherSDKConfig = { ...base };
	const apiKey = agent.api?.key;
	const apiEndpoint = agent.api?.endpoint;
	switch (kind) {
		case "claude":
			if (apiKey !== undefined && out.apiKey === undefined) out.apiKey = apiKey;
			if (apiEndpoint !== undefined && out.baseURL === undefined) {
				out.baseURL = apiEndpoint;
			}
			break;
		case "codex":
			if (apiKey !== undefined && out.apiKey === undefined) out.apiKey = apiKey;
			break;
		case "copilot":
			if (apiKey !== undefined && out.gitHubToken === undefined) {
				out.gitHubToken = apiKey;
			}
			if (apiEndpoint !== undefined && out.cliUrl === undefined) {
				out.cliUrl = apiEndpoint;
			}
			break;
		case "cursor":
			if (apiKey !== undefined && out.apiKey === undefined) out.apiKey = apiKey;
			break;
		case "kimi":
			if (apiKey !== undefined || apiEndpoint !== undefined) {
				const kimiEnv = { ...(out.env ?? {}) };
				if (apiKey !== undefined && kimiEnv.MOONSHOT_API_KEY === undefined) {
					kimiEnv.MOONSHOT_API_KEY = apiKey;
				}
				if (
					apiEndpoint !== undefined &&
					kimiEnv.MOONSHOT_BASE_URL === undefined
				) {
					kimiEnv.MOONSHOT_BASE_URL = apiEndpoint;
				}
				out.env = kimiEnv;
			}
			break;
		case "opencode":
			if (apiEndpoint !== undefined && out.baseURL === undefined) {
				out.baseURL = apiEndpoint;
			}
			if (apiKey !== undefined) {
				const headers = { ...(out.headers ?? {}) };
				if (headers.Authorization === undefined) {
					headers.Authorization = `Bearer ${apiKey}`;
				}
				out.headers = headers;
			}
			break;
	}
	if (Object.keys(agent.env).length > 0) {
		out.env = { ...agent.env, ...(out.env ?? {}) };
	}
	return out;
}

function buildInstance(
	kind: SdkKind,
	config: SeherSDKConfig,
): SeherSDKInstance {
	let effective = config;
	if (NO_TOOL_SUPPORT.has(kind) && hasTools(effective)) {
		console.warn(
			`[SeherSDK] tools registration is not supported by '${kind}'; ${effective.tools?.length ?? 0} tool(s) will be ignored.`,
		);
		effective = stripTools(effective);
	}
	if (NO_ENV_SUPPORT.has(kind) && effective.env !== undefined) {
		const count = Object.keys(effective.env).length;
		if (count > 0) {
			console.warn(
				`[SeherSDK] env passthrough is not supported by '${kind}'; ${count} env entr${count === 1 ? "y" : "ies"} will be ignored.`,
			);
			effective = stripEnv(effective);
		}
	}
	switch (kind) {
		case "claude":
			return new ClaudeSDK(effective);
		case "codex":
			return new CodexSDK(effective);
		case "copilot":
			return new CopilotSDK(effective);
		case "kimi":
			return new KimiSDK(effective);
		case "opencode":
			return new OpencodeSDK(effective);
		case "cursor":
			return new CursorSDK(effective);
	}
}

/**
 * Public entry point for the Seher SDK. Either provide an explicit `kind` to
 * behave as a thin wrapper around the matching provider SDK, or omit `kind`
 * to auto-select a provider/model from the user's YAML config.
 */
export class SeherSDK {
	private readonly opts: SeherSDKOptions;
	private instance: SeherSDKInstance | null = null;
	private resolvedAgent: ResolvedAgent | null = null;
	private pending: Promise<SeherSDKInstance> | null = null;

	constructor(opts: SeherSDKOptions = {}) {
		this.opts = opts;
		if (opts.kind !== undefined) {
			this.instance = buildInstance(opts.kind, opts);
		}
	}

	get kind(): SdkKind {
		if (this.instance === null) {
			throw new Error(
				"SeherSDK kind is not yet resolved; call run()/stream()/resolved() first or pass `kind` in options",
			);
		}
		return this.instance.kind;
	}

	async run(runOpts: SeherRunOptions): Promise<SeherRunResult> {
		if (!this.shouldRetryOnLimit()) {
			const sdk = await this.ensure();
			return sdk.run(this.translateRunOpts(runOpts));
		}
		const excluded: string[] = [];
		while (true) {
			try {
				const sdk = await this.resolveForRetry(excluded);
				return await sdk.run(this.translateRunOpts(runOpts));
			} catch (err) {
				const next = await this.handleRetryError(err, excluded);
				if (next === "rethrow") throw err;
			}
		}
	}

	stream(runOpts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		if (!this.shouldRetryOnLimit()) {
			return {
				async *[Symbol.asyncIterator]() {
					const sdk = await self.ensure();
					const translated = self.translateRunOpts(runOpts);
					for await (const chunk of sdk.stream(translated)) yield chunk;
				},
			};
		}
		return {
			async *[Symbol.asyncIterator]() {
				const excluded: string[] = [];
				while (true) {
					let sdk: SeherSDKInstance;
					try {
						sdk = await self.resolveForRetry(excluded);
					} catch (err) {
						const next = await self.handleRetryError(err, excluded);
						if (next === "rethrow") throw err;
						continue;
					}
					const translated = self.translateRunOpts(runOpts);
					try {
						for await (const chunk of sdk.stream(translated)) yield chunk;
						return;
					} catch (err) {
						const next = await self.handleRetryError(err, excluded);
						if (next === "rethrow") throw err;
					}
				}
			},
		};
	}

	/** Force resolution and return the chosen kind plus the source agent (if auto-resolved). */
	async resolved(): Promise<{ kind: SdkKind; agent: ResolvedAgent | null }> {
		const sdk = await this.ensure();
		return { kind: sdk.kind, agent: this.resolvedAgent };
	}

	/** Drop any cached resolution so the next call re-runs CodexBar checks. */
	reset(): void {
		this.resolvedAgent = null;
		this.pending = null;
		if (this.opts.kind !== undefined) {
			this.instance = buildInstance(this.opts.kind, this.opts);
		} else {
			this.instance = null;
		}
	}

	private ensure(): Promise<SeherSDKInstance> {
		if (this.instance !== null) return Promise.resolve(this.instance);
		if (this.pending !== null) return this.pending;
		const pending = this.doResolve().catch((err) => {
			this.pending = null;
			throw err;
		});
		this.pending = pending;
		return pending;
	}

	private async doResolve(): Promise<SeherSDKInstance> {
		const { mode, provider, configPath, noWait, maxRescans } = this.opts;
		const resolveOpts: ResolveAgentOptions = {
			...(this.opts.resolveOverrides ?? {}),
			...(mode !== undefined && { modeKey: mode }),
			...(provider !== undefined && { provider }),
			...(configPath !== undefined && { configPath }),
			...(noWait !== undefined && { noWait }),
			...(maxRescans !== undefined && { maxRescans }),
		};
		if (requiresToolsSupport(this.opts)) {
			resolveOpts.requireToolsSupport = true;
		}

		const agent = await resolveAgent(resolveOpts);
		this.resolvedAgent = agent;
		const merged = applyResolvedAgent(agent.kind, this.opts, agent);
		this.instance = buildInstance(agent.kind, merged);
		return this.instance;
	}

	private shouldRetryOnLimit(): boolean {
		return this.opts.retryOnLimit === true && this.opts.kind === undefined;
	}

	private async resolveForRetry(
		excluded: readonly string[],
	): Promise<SeherSDKInstance> {
		if (this.instance !== null) return this.instance;
		const { mode, provider, configPath, maxRescans } = this.opts;
		const resolveOpts: ResolveAgentOptions = {
			...(this.opts.resolveOverrides ?? {}),
			noWait: true,
			...(mode !== undefined && { modeKey: mode }),
			...(provider !== undefined && { provider }),
			...(configPath !== undefined && { configPath }),
			...(maxRescans !== undefined && { maxRescans }),
			...(excluded.length > 0 && { excludeProviders: [...excluded] }),
		};
		if (requiresToolsSupport(this.opts)) {
			resolveOpts.requireToolsSupport = true;
		}
		const agent = await resolveAgent(resolveOpts);
		this.resolvedAgent = agent;
		const merged = applyResolvedAgent(agent.kind, this.opts, agent);
		this.instance = buildInstance(agent.kind, merged);
		return this.instance;
	}

	private async handleRetryError(
		err: unknown,
		excluded: string[],
	): Promise<"retry" | "rethrow"> {
		if (err instanceof LimitError) {
			const provider = this.resolvedAgent?.provider ?? err.provider;
			if (provider !== undefined) {
				const info: LimitRetryInfo = { provider };
				if (err.resetAt !== undefined) info.resetAt = err.resetAt;
				this.opts.onLimitRetry?.(info);
				if (!excluded.includes(provider)) excluded.push(provider);
			}
			this.reset();
			return "retry";
		}
		if (err instanceof AllAgentsLimitedError) {
			this.opts.onAllLimited?.();
			const pollOpts: Parameters<typeof pollForAgent>[0] = {};
			if (this.opts.mode !== undefined) pollOpts.modeKey = this.opts.mode;
			if (this.opts.provider !== undefined)
				pollOpts.provider = this.opts.provider;
			if (this.opts.configPath !== undefined)
				pollOpts.configPath = this.opts.configPath;
			if (this.opts.limitPollIntervalMs !== undefined)
				pollOpts.intervalMs = this.opts.limitPollIntervalMs;
			if (this.opts.onLimitWaitTick !== undefined)
				pollOpts.onTick = this.opts.onLimitWaitTick;
			if (this.opts.limitWaitSignal !== undefined)
				pollOpts.signal = this.opts.limitWaitSignal;
			const ro = this.opts.resolveOverrides;
			if (ro?.checkLimit !== undefined) pollOpts.checkLimit = ro.checkLimit;
			if (ro?.loadConfig !== undefined) pollOpts.loadConfig = ro.loadConfig;
			if (ro?.config !== undefined) pollOpts.config = ro.config;
			if (requiresToolsSupport(this.opts)) {
				pollOpts.requireToolsSupport = true;
			}
			const agent = await pollForAgent(pollOpts);
			excluded.length = 0;
			this.resolvedAgent = agent;
			const merged = applyResolvedAgent(agent.kind, this.opts, agent);
			this.instance = buildInstance(agent.kind, merged);
			return "retry";
		}
		return "rethrow";
	}

	/**
	 * Always pin the run to the resolved model unless the caller explicitly
	 * overrides via `runOpts.model`. Explicit-kind users without a resolved
	 * agent fall through with whatever they passed.
	 */
	private translateRunOpts(runOpts: SeherRunOptions): SeherRunOptions {
		if (runOpts.model !== undefined) return runOpts;
		const agent = this.resolvedAgent;
		if (agent === null) return runOpts;
		return { ...runOpts, model: agent.modelId };
	}
}

export { AllAgentsLimitedError, type LimitError, NoMatchingAgentError };
