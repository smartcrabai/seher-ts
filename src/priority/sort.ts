import { priorityRuleMatches } from "../schedule/ruleMatch.ts";
import type { AgentConfig, PriorityRule } from "../schedule/types.ts";

function scheduleSpecificity(rule: PriorityRule): number {
	return (rule.weekdays ? 1 : 0) + (rule.hours ? 1 : 0);
}

export function priorityForAgent(
	priorities: PriorityRule[],
	agent: AgentConfig,
	selectedModel: string | null,
	now: Date,
): number {
	let best: PriorityRule | null = null;
	for (const rule of priorities) {
		if (!priorityRuleMatches(rule, agent, selectedModel, now)) continue;
		if (
			best === null ||
			scheduleSpecificity(rule) > scheduleSpecificity(best)
		) {
			best = rule;
		}
	}
	return best ? best.priority : 0;
}

export function sortByPriority(
	agents: AgentConfig[],
	priorities: PriorityRule[],
	selectedModel: string | null,
	now: Date,
): AgentConfig[] {
	const decorated = agents.map((agent, index) => ({
		agent,
		index,
		priority: priorityForAgent(priorities, agent, selectedModel, now),
	}));
	decorated.sort((a, b) => {
		if (a.priority !== b.priority) return b.priority - a.priority;
		return a.index - b.index;
	});
	return decorated.map((d) => d.agent);
}
