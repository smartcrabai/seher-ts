import { checkLimit as checkLimitImpl } from "../codexbar/limit.ts";
import { loadSettings as loadSettingsImpl } from "../config/load.ts";
import type { FilterOptions } from "../priority/filter.ts";
import { filterAgents as filterAgentsImpl } from "../priority/filter.ts";
import { sortByPriority as sortByPriorityImpl } from "../priority/sort.ts";
import { scanCandidates } from "../scan.ts";
import { sleepUntil as sleepUntilImpl } from "../sleep/sleepUntil.ts";
import type { AgentConfig, Settings } from "../types.ts";

export class AllAgentsLimitedError extends Error {
	readonly minReset: Date;
	constructor(minReset: Date) {
		super(
			`All agents are rate-limited; earliest reset at ${minReset.toISOString()}`,
		);
		this.name = "AllAgentsLimitedError";
		this.minReset = minReset;
	}
}

export class NoMatchingAgentError extends Error {
	constructor(message = "No agents match the specified filters") {
		super(message);
		this.name = "NoMatchingAgentError";
	}
}

export interface ResolveAgentOptions {
	command?: string;
	provider?: string;
	model?: string;
	configPath?: string;
	/** When true, throw `AllAgentsLimitedError` instead of sleeping. */
	noWait?: boolean;
	/** Maximum rescans after sleep. Defaults to 1, matching CLI behavior. */
	maxRescans?: number;
	/** Pre-loaded settings; if provided, `configPath` is ignored. */
	settings?: Settings;
	/** Pre-sorted agents; if provided, filter/sort steps are skipped. */
	sortedAgents?: AgentConfig[];
	loadSettings?: typeof loadSettingsImpl;
	filterAgents?: typeof filterAgentsImpl;
	sortByPriority?: typeof sortByPriorityImpl;
	checkLimit?: typeof checkLimitImpl;
	sleepUntil?: typeof sleepUntilImpl;
	now?: () => Date;
	quiet?: boolean;
	onSleep?: (until: Date) => void;
}

export function providerNameOf(agent: AgentConfig): string | null {
	switch (agent.provider.kind) {
		case "explicit":
			return agent.provider.name;
		case "inferred":
			return agent.command;
		case "none":
			return null;
	}
}

export async function resolveAgent(
	opts: ResolveAgentOptions = {},
): Promise<AgentConfig> {
	const loadSettings = opts.loadSettings ?? loadSettingsImpl;
	const filterAgents = opts.filterAgents ?? filterAgentsImpl;
	const sortByPriority = opts.sortByPriority ?? sortByPriorityImpl;
	const checkLimit = opts.checkLimit ?? checkLimitImpl;
	const sleepUntil = opts.sleepUntil ?? sleepUntilImpl;
	const now = opts.now ?? (() => new Date());
	const maxRescans = opts.maxRescans ?? 1;

	let sorted = opts.sortedAgents;
	if (sorted === undefined) {
		const settings = opts.settings ?? (await loadSettings(opts.configPath));
		const filterOpts: FilterOptions = {
			...(opts.command !== undefined && { command: opts.command }),
			...(opts.provider !== undefined && { provider: opts.provider }),
			...(opts.model !== undefined && { model: opts.model }),
		};
		const filtered = filterAgents(settings.agents, filterOpts);
		sorted = sortByPriority(
			filtered,
			settings.priority,
			opts.model ?? null,
			now(),
		);
	}

	if (sorted.length === 0) {
		throw new NoMatchingAgentError();
	}

	let rescans = 0;
	while (true) {
		const scan = await scanCandidates(sorted, async (agent) => {
			const providerName = providerNameOf(agent);
			if (providerName === null) return { kind: "not_limited" } as const;
			return checkLimit(providerName);
		});

		if (scan.kind === "available") {
			const a = sorted[scan.index];
			if (a === undefined) {
				throw new Error("Internal error: scan returned out-of-range index");
			}
			return a;
		}
		if (scan.kind === "no_agents") {
			throw new NoMatchingAgentError("No available agents");
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
