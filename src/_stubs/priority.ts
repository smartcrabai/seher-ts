// TODO(post-merge): replace with import from ../priority.
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

import type { Agent, PriorityRule } from "./types.ts";

export interface FilterOptions {
	command?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
}

export function filterAgents(agents: Agent[], _opts: FilterOptions): Agent[] {
	return agents;
}

export function sortByPriority(
	agents: Agent[],
	_priorities: PriorityRule[],
	_model: string | undefined,
	_now: Date,
): Agent[] {
	return agents;
}
