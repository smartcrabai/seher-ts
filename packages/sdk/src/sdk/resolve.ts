import { CodexBarError, CodexBarNotFoundError } from "../codexbar/errors.ts";
import { checkLimit as checkLimitImpl } from "../codexbar/limit.ts";
import { loadConfig as loadConfigImpl } from "../config/load.ts";
import { scanCandidates } from "../scan.ts";
import { sleepUntil as sleepUntilImpl } from "../sleep/sleepUntil.ts";
import type { AgentLimit, Config, ResolvedAgent } from "../types.ts";

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
	/** Force a specific provider key (skips priority). */
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
	loadConfig?: typeof loadConfigImpl;
	checkLimit?: typeof checkLimitImpl;
}

interface Candidate {
	provider: string;
	priority: number;
	order: number;
	resolved: ResolvedAgent;
}

function effectivePriority(
	providerPriority: number | undefined,
	modelPriority: number | undefined,
): number {
	return modelPriority ?? providerPriority ?? 0;
}

function buildCandidates(
	config: Config,
	modeKey: string,
	providerFilter: string | undefined,
	excludeProviders: readonly string[] | undefined,
): Candidate[] {
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
		const model = entry.models[modeKey];
		if (model === undefined) continue;
		const priority = effectivePriority(entry.priority, model.priority);
		const resolved: ResolvedAgent = {
			provider: entry.provider,
			kind: entry.sdk,
			modelId: model.model,
			modeKey,
			env: {},
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
	const candidates = buildCandidates(
		config,
		modeKey,
		opts.provider,
		opts.excludeProviders,
	);

	if (candidates.length === 0) {
		throw new NoMatchingAgentError(
			opts.provider !== undefined
				? `No provider "${opts.provider}" defines models.${modeKey}`
				: `No providers define models.${modeKey}`,
		);
	}

	let rescans = 0;
	while (true) {
		const scan = await scanCandidates(candidates, async (c) =>
			probe(checkLimit, c.provider),
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
	const candidates = buildCandidates(
		config,
		modeKey,
		opts.provider,
		opts.excludeProviders,
	);

	if (candidates.length === 0) {
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
			probe(checkLimit, c.provider),
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
