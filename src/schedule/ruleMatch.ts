import type { AgentConfig, PriorityRule, ProviderConfig } from "../types.ts";
import { isScheduleActive } from "./evaluate.ts";

function commandToProvider(command: string): string | null {
	switch (command) {
		case "claude":
			return "claude";
		case "codex":
			return "codex";
		case "copilot":
			return "copilot";
		case "glm":
			return "glm";
		case "zai":
			return "zai";
		case "kimi-k2":
			return "kimi-k2";
		case "warp":
			return "warp";
		case "kiro":
			return "kiro";
		default:
			return null;
	}
}

export function resolveProvider(
	command: string,
	provider: ProviderConfig,
): string | null {
	switch (provider.kind) {
		case "explicit":
			return provider.name;
		case "none":
			return null;
		case "inferred":
			return commandToProvider(command);
	}
}

export function agentIsUsable(agent: AgentConfig, now: Date): boolean {
	if (agent.active && !isScheduleActive(agent.active, now)) return false;
	if (agent.inactive && isScheduleActive(agent.inactive, now)) return false;
	return true;
}

export function priorityRuleMatches(
	rule: PriorityRule,
	agent: AgentConfig,
	selectedModel: string | null,
	now: Date,
): boolean {
	if (rule.command !== agent.command) return false;
	if (
		resolveProvider(rule.command, rule.provider) !==
		resolveProvider(agent.command, agent.provider)
	) {
		return false;
	}
	if (rule.model !== selectedModel) return false;
	return isScheduleActive({ weekdays: rule.weekdays, hours: rule.hours }, now);
}
