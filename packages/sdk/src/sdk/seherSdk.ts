import { filterAgents as filterAgentsImpl } from "../priority/filter.ts";
import type { AgentConfig } from "../types.ts";
import { ClaudeSDK, type ClaudeSDKConfig } from "./claude.ts";
import { CodexSDK, type CodexSDKConfig } from "./codex.ts";
import { CopilotSDK, type CopilotSDKConfig } from "./copilot.ts";
import { CursorSDK, type CursorSDKConfig } from "./cursor.ts";
import { KimiSDK, type KimiSDKConfig } from "./kimi.ts";
import { OpencodeSDK, type OpencodeSDKConfig } from "./opencode.ts";
import {
	AllAgentsLimitedError,
	NoMatchingAgentError,
	type ResolveAgentOptions,
	resolveAgent,
} from "./resolve.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

/** SDKs that don't support in-process JS tool registration. */
const NO_TOOL_SUPPORT: ReadonlySet<SdkKind> = new Set<SdkKind>([
	"codex",
	"cursor",
	"opencode",
]);

/** SDKs whose underlying lib does not accept env passthrough. */
const NO_ENV_SUPPORT: ReadonlySet<SdkKind> = new Set<SdkKind>([
	"codex",
	"copilot",
	"cursor",
	"opencode",
]);

const canCarryTools = (a: AgentConfig): boolean =>
	a.sdk == null || !NO_TOOL_SUPPORT.has(a.sdk);

function hasTools(config: SeherSDKConfig): boolean {
	return config.tools !== undefined && config.tools.length > 0;
}

function stripTools(config: SeherSDKConfig): SeherSDKConfig {
	const { tools: _tools, ...rest } = config;
	return rest;
}

function stripEnv(config: SeherSDKConfig): SeherSDKConfig {
	const { env: _env, ...rest } = config;
	return rest;
}

function mergeAgentDefaults(
	opts: SeherSDKOptions,
	agent: AgentConfig,
): SeherSDKOptions {
	if (agent.env === null) return opts;
	return {
		...opts,
		env: { ...agent.env, ...(opts.env ?? {}) },
	};
}

function wrapFilterForTools(
	base: ResolveAgentOptions["filterAgents"] | undefined,
): typeof filterAgentsImpl {
	const inner = base ?? filterAgentsImpl;
	return (agents, filterOpts) =>
		inner(agents, filterOpts).filter(canCarryTools);
}

export type SeherSDKConfig = ClaudeSDKConfig &
	CodexSDKConfig &
	CopilotSDKConfig &
	CursorSDKConfig &
	KimiSDKConfig &
	OpencodeSDKConfig;

export interface SeherSDKOptions extends SeherSDKConfig {
	/** When provided, skip auto-resolution and use this provider directly. */
	kind?: SdkKind;
	/** Filter to a specific agent command (e.g., "claude"). */
	command?: string;
	/** Filter to a specific provider (e.g., "anthropic"). */
	provider?: string;
	/** Filter to agents that declare this model key in their `models` map. */
	model?: string;
	/** Override the settings file path (defaults to `~/.config/seher/settings.jsonc`). */
	configPath?: string;
	/** Throw `AllAgentsLimitedError` instead of sleeping when all agents are limited. */
	noWait?: boolean;
	/** Maximum rescans after sleep. Defaults to 1 (matches CLI). */
	maxRescans?: number;
	/** Advanced: override individual collaborators used during resolution (tests). */
	resolveOverrides?: Pick<
		ResolveAgentOptions,
		| "loadSettings"
		| "filterAgents"
		| "sortByPriority"
		| "checkLimit"
		| "sleepUntil"
		| "now"
		| "settings"
		| "sortedAgents"
		| "quiet"
		| "onSleep"
	>;
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
 * Public entry point for the Seher SDK. Either provide an explicit
 * `kind: "claude" | "codex" | "copilot" | "kimi" | "opencode" | "cursor"` to
 * behave as a thin wrapper around the matching provider SDK, or omit `kind`
 * to have Seher auto-select an agent from the user's settings file
 * (mirroring CLI behavior, including CodexBar `limited` checks and
 * sleep-until-reset on rate limits).
 *
 * Not declared as `implements SeherSDKInstance` because `kind` throws when
 * auto-resolution has not yet run, which would violate the interface
 * contract that requires `kind` to always return a value.
 */
export class SeherSDK {
	private readonly opts: SeherSDKOptions;
	private instance: SeherSDKInstance | null = null;
	private resolvedAgent: AgentConfig | null = null;
	private pending: Promise<SeherSDKInstance> | null = null;

	constructor(opts: SeherSDKOptions = {}) {
		this.opts = opts;
		if (opts.kind !== undefined) {
			this.instance = buildInstance(opts.kind, opts);
		}
	}

	/**
	 * Resolved provider kind. Throws if auto-resolution has not run yet —
	 * call `run()` / `stream()` / `resolved()` first, or pass `kind` in options.
	 */
	get kind(): SdkKind {
		if (this.instance === null) {
			throw new Error(
				"SeherSDK kind is not yet resolved; call run()/stream()/resolved() first or pass `kind` in options",
			);
		}
		return this.instance.kind;
	}

	async run(runOpts: SeherRunOptions): Promise<SeherRunResult> {
		const sdk = await this.ensure();
		return sdk.run(this.translateRunOpts(runOpts));
	}

	stream(runOpts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const sdk = await self.ensure();
				const translated = self.translateRunOpts(runOpts);
				for await (const chunk of sdk.stream(translated)) yield chunk;
			},
		};
	}

	/** Force resolution and return the chosen kind plus the source agent (if auto-resolved). */
	async resolved(): Promise<{ kind: SdkKind; agent: AgentConfig | null }> {
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
		const { command, provider, model, configPath, noWait, maxRescans } =
			this.opts;
		const resolveOpts: ResolveAgentOptions = {
			...(this.opts.resolveOverrides ?? {}),
			...(command !== undefined && { command }),
			...(provider !== undefined && { provider }),
			...(model !== undefined && { model }),
			...(configPath !== undefined && { configPath }),
			...(noWait !== undefined && { noWait }),
			...(maxRescans !== undefined && { maxRescans }),
		};

		// resolveAgent() bypasses filterAgents when sortedAgents is provided
		// (resolve.ts:73-88), so apply the predicate to both paths.
		if (hasTools(this.opts)) {
			resolveOpts.filterAgents = wrapFilterForTools(
				this.opts.resolveOverrides?.filterAgents,
			);
			if (resolveOpts.sortedAgents !== undefined) {
				resolveOpts.sortedAgents =
					resolveOpts.sortedAgents.filter(canCarryTools);
			}
		}

		const agent = await resolveAgent(resolveOpts);
		if (agent.sdk === undefined || agent.sdk === null) {
			throw new Error(
				`Resolved agent "${agent.command}" has no \`sdk\` field set; cannot create an SDK instance. Set \`sdk: "claude" | "codex" | "copilot" | "kimi" | "opencode" | "cursor"\` on the agent in settings.jsonc.`,
			);
		}
		this.resolvedAgent = agent;
		const merged = mergeAgentDefaults(this.opts, agent);
		this.instance = buildInstance(agent.sdk, merged);
		return this.instance;
	}

	/**
	 * Translate `runOpts.model` via the resolved agent's `models` map. Falls
	 * back to `this.opts.model` (the construction-time filter key) so that a
	 * caller who did `new SeherSDK({ model: "sonnet" })` and then `run({ ... })`
	 * still gets the agent's mapped model id.
	 */
	private translateRunOpts(runOpts: SeherRunOptions): SeherRunOptions {
		const agent = this.resolvedAgent;
		if (agent === null || agent.models === null) return runOpts;
		const key = runOpts.model ?? this.opts.model;
		if (key === undefined) return runOpts;
		const resolved = agent.models[key];
		if (resolved === undefined) return runOpts;
		return { ...runOpts, model: resolved };
	}
}

export { AllAgentsLimitedError, NoMatchingAgentError };
