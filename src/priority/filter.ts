import { resolveProvider } from "../schedule/ruleMatch.ts";
import type { AgentConfig } from "../types.ts";

export interface FilterOptions {
	command?: string;
	provider?: string;
	model?: string;
}

export function filterAgents(
	agents: AgentConfig[],
	opts: FilterOptions,
): AgentConfig[] {
	let result = agents;
	if (opts.command !== undefined) {
		const cmd = opts.command;
		result = result.filter((a) => a.command === cmd);
	}
	if (opts.provider !== undefined) {
		const p = opts.provider;
		result = result.filter((a) => resolveProvider(a.command, a.provider) === p);
	}
	if (opts.model !== undefined) {
		const m = opts.model;
		result = result.filter((a) => !a.models || Object.hasOwn(a.models, m));
	}
	return result;
}
