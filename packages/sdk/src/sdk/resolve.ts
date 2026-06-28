import { CodexBarError, CodexBarNotFoundError } from "../codexbar/errors.ts";
import {
	checkLimit as checkLimitImpl,
	codexbarProviderName,
} from "../codexbar/limit.ts";
import { loadConfig as loadConfigImpl } from "../config/load.ts";
import { scanCandidates } from "../scan.ts";
import { sleepUntil as sleepUntilImpl } from "../sleep/sleepUntil.ts";
import type {
	AgentLimit,
	Config,
	ResolvedAgent,
	ResolvedSkillsConfig,
	SdkKind,
	SkillsConfig,
} from "../types.ts";

function resolveSkills(
	providerSkills: SkillsConfig | undefined,
	rootSkills: SkillsConfig | undefined,
): ResolvedSkillsConfig {
	return {
		includeClaude:
			providerSkills?.includeClaude ?? rootSkills?.includeClaude ?? true,
	};
}

/** SDKs that support in-process JS tool registration. */
export const TOOL_SUPPORTING_KINDS: ReadonlySet<SdkKind> = new Set<SdkKind>([
	"claude",
	"copilot",
	"kimi",
]);

const NO_PROVIDERS_WITH_TOOLS_ERROR = (modeKey: string) =>
	`No providers with tools support define models.${modeKey}`;

export class AllAgentsLimitedError extends Error {
	readonly minReset: Date;
	constructor(minReset: Date) {
		super(
			`All providers are rate-limited; earliest reset at ${minReset.toISOString()}`,
		);
		this.name = "AllAgentsLimitedError";
		this.minReset = minReset;
	}
}

export class NoMatchingAgentError extends Error {
	constructor(message = "No providers match the specified filters") {
		super(message);
		this.name = "NoMatchingAgentError";
	}
}

export interface ResolveAgentOptions {
	/** Mode key (e.g., `plan`, `build`, or a custom key). Defaults to `build`. */
	modeKey?: string;
	/** Force a resolved provider name (skips priority, filters by `entry.provider`). */
	provider?: string;
	/** Path to the YAML config file. */
	configPath?: string;
	/** Pre-loaded config; if provided, `configPath` is ignored. */
	config?: Config;
	/** Provider keys to exclude from candidate selection. */
	excludeProviders?: string[];
	/** When true, throw `AllAgentsLimitedError` instead of sleeping. */
	noWait?: boolean;
	/** Maximum rescans after a sleep cycle. Defaults to 1. */
	maxRescans?: number;
	/** When true, only consider providers whose SDK kind supports tools. */
	requireToolsSupport?: boolean;
	loadConfig?: typeof loadConfigImpl;
	checkLimit?: typeof checkLimitImpl;
	sleepUntil?: typeof sleepUntilImpl;
	now?: () => Date;
	quiet?: boolean;
	onSleep?: (until: Date) => void;
}

export interface PollForAgentOptions {
	/** Mode key (default: `build`). */
	modeKey?: string;
	/** Force a specific provider key. */
	provider?: string;
	/** Path to the YAML config file. */
	configPath?: string;
	/** Pre-loaded config; if provided, `configPath` is ignored. */
	config?: Config;
	/** Provider keys to exclude. */
	excludeProviders?: string[];
	/** Polling interval in ms. Defaults to 60_000. */
	intervalMs?: number;
	/** Cancellation signal. When aborted, throws an `AbortError`. */
	signal?: AbortSignal;
	/** Called once before each scan attempt (1-based). */
	onTick?: (attempt: number) => void;
	/** When true, only consider providers whose SDK kind supports tools. */
	requireToolsSupport?: boolean;
	loadConfig?: typeof loadConfigImpl;
	checkLimit?: typeof checkLimitImpl;
}

export interface Candidate {
	provider: string;
	priority: number;
	order: number;
	resolved: ResolvedAgent;
}

/**
 * `buildCandidates` のオプション。`modeKey` のみ必須で、他は任意。
 */
export interface BuildCandidatesOptions {
	/** Mode key (e.g., `plan`, `build`). */
	modeKey: string;
	/** `-p` で指定された provider key (一致するもののみ残す)。 */
	providerFilter?: string;
	/** 候補から除外する provider key 一覧。 */
	excludeProviders?: readonly string[];
	/** true のとき tools をサポートしない SDK を除外する。 */
	requireToolsSupport?: boolean;
}

function effectivePriority(
	providerPriority: number | undefined,
	modelPriority: number | undefined,
): number {
	return modelPriority ?? providerPriority ?? 0;
}

/**
 * config から優先度順に候補を組み立てる。`--show-resolution` のように、
 * resolve 全体を走らせずに候補リストだけ欲しい呼び出し側のために export している。
 */
export function buildCandidates(
	config: Config,
	opts: BuildCandidatesOptions,
): Candidate[] {
	const { modeKey, providerFilter, excludeProviders, requireToolsSupport } =
		opts;
	const excluded =
		excludeProviders !== undefined && excludeProviders.length > 0
			? new Set(excludeProviders)
			: null;
	const list: Candidate[] = [];
	for (const entry of config.providers) {
		if (providerFilter !== undefined && entry.provider !== providerFilter) {
			continue;
		}
		if (excluded?.has(entry.provider)) continue;
		if (requireToolsSupport && !TOOL_SUPPORTING_KINDS.has(entry.sdk)) {
			continue;
		}
		const model = entry.models[modeKey];
		if (model === undefined) continue;
		const priority = effectivePriority(entry.priority, model.priority);
		const resolved: ResolvedAgent = {
			provider: entry.provider,
			kind: entry.sdk,
			modelId: model.model,
			modeKey,
			env: {},
			skills: resolveSkills(entry.skills, config.skills),
		};
		if (entry.api !== undefined) resolved.api = entry.api;
		list.push({
			provider: entry.provider,
			priority,
			order: entry.order,
			resolved,
		});
	}
	list.sort((a, b) => {
		if (a.priority !== b.priority) return b.priority - a.priority;
		return a.order - b.order;
	});
	return list;
}

async function probe(
	checkLimit: typeof checkLimitImpl,
	provider: string,
): Promise<AgentLimit> {
	try {
		return await checkLimit(provider);
	} catch (err) {
		// CodexBar entries can be missing for community providers (e.g. zai),
		// the binary itself may be absent on some hosts, or the spawn may fail
		// transiently. Treat all of those as "always available" so resolution
		// proceeds with the provider rather than skipping it forever.
		if (err instanceof CodexBarError || err instanceof CodexBarNotFoundError) {
			return { kind: "not_limited" };
		}
		throw err;
	}
}

export async function resolveAgent(
	opts: ResolveAgentOptions = {},
): Promise<ResolvedAgent> {
	const loadConfig = opts.loadConfig ?? loadConfigImpl;
	const checkLimit = opts.checkLimit ?? checkLimitImpl;
	const sleepUntil = opts.sleepUntil ?? sleepUntilImpl;
	const maxRescans = opts.maxRescans ?? 1;
	const modeKey = opts.modeKey ?? "build";

	const config = opts.config ?? (await loadConfig(opts.configPath));
	const buildOpts: BuildCandidatesOptions = { modeKey };
	if (opts.provider !== undefined) buildOpts.providerFilter = opts.provider;
	if (opts.excludeProviders !== undefined)
		buildOpts.excludeProviders = opts.excludeProviders;
	if (opts.requireToolsSupport !== undefined)
		buildOpts.requireToolsSupport = opts.requireToolsSupport;
	const candidates = buildCandidates(config, buildOpts);

	if (candidates.length === 0) {
		if (opts.requireToolsSupport) {
			throw new NoMatchingAgentError(NO_PROVIDERS_WITH_TOOLS_ERROR(modeKey));
		}
		throw new NoMatchingAgentError(
			opts.provider !== undefined
				? `No provider "${opts.provider}" defines models.${modeKey}`
				: `No providers define models.${modeKey}`,
		);
	}

	let rescans = 0;
	while (true) {
		const scan = await scanCandidates(candidates, async (c) =>
			probe(checkLimit, codexbarProviderName(c.resolved.kind, c.provider)),
		);

		if (scan.kind === "available") {
			const c = candidates[scan.index];
			if (c === undefined) {
				throw new Error("Internal error: scan returned out-of-range index");
			}
			return c.resolved;
		}
		if (scan.kind === "no_agents") {
			throw new NoMatchingAgentError("No available providers");
		}
		if (opts.noWait || rescans >= maxRescans) {
			throw new AllAgentsLimitedError(scan.minReset);
		}
		opts.onSleep?.(scan.minReset);
		await sleepUntil(scan.minReset, {
			...(opts.quiet !== undefined && { quiet: opts.quiet }),
		});
		rescans += 1;
	}
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Block until at least one configured provider is non-limited.
 *
 * Unlike `resolveAgent`, this never throws `AllAgentsLimitedError`: when all
 * candidates are limited, it sleeps `intervalMs` (default 60s) and re-probes.
 * Use for retry/recovery paths where indefinite waiting is desired.
 *
 * Aborts via `opts.signal` cause the returned promise to reject — either with
 * `signal.reason` or a `DOMException("…", "AbortError")` per `throwIfAborted`.
 */
export async function pollForAgent(
	opts: PollForAgentOptions = {},
): Promise<ResolvedAgent> {
	const loadConfig = opts.loadConfig ?? loadConfigImpl;
	const checkLimit = opts.checkLimit ?? checkLimitImpl;
	const modeKey = opts.modeKey ?? "build";
	const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

	const config = opts.config ?? (await loadConfig(opts.configPath));
	const buildOpts: BuildCandidatesOptions = { modeKey };
	if (opts.provider !== undefined) buildOpts.providerFilter = opts.provider;
	if (opts.excludeProviders !== undefined)
		buildOpts.excludeProviders = opts.excludeProviders;
	if (opts.requireToolsSupport !== undefined)
		buildOpts.requireToolsSupport = opts.requireToolsSupport;
	const candidates = buildCandidates(config, buildOpts);

	if (candidates.length === 0) {
		if (opts.requireToolsSupport) {
			throw new NoMatchingAgentError(NO_PROVIDERS_WITH_TOOLS_ERROR(modeKey));
		}
		throw new NoMatchingAgentError(
			opts.provider !== undefined
				? `No provider "${opts.provider}" defines models.${modeKey}`
				: `No providers define models.${modeKey}`,
		);
	}

	let attempt = 0;
	while (true) {
		opts.signal?.throwIfAborted();
		attempt += 1;
		opts.onTick?.(attempt);
		const scan = await scanCandidates(candidates, async (c) =>
			probe(checkLimit, codexbarProviderName(c.resolved.kind, c.provider)),
		);
		if (scan.kind === "available") {
			const c = candidates[scan.index];
			if (c === undefined) {
				throw new Error("Internal error: scan returned out-of-range index");
			}
			return c.resolved;
		}
		if (scan.kind === "no_agents") {
			throw new NoMatchingAgentError("No available providers");
		}
		await sleepUntilImpl(new Date(Date.now() + intervalMs), {
			quiet: true,
			...(opts.signal !== undefined && { signal: opts.signal }),
		});
	}
}
