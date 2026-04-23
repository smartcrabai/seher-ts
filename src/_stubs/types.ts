// TODO(post-merge): replace with import from ../types.ts (Unit 1).
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

export interface AgentConfig {
	command: string;
	provider?: string | undefined;
	models?: Record<string, string> | undefined;
}

export interface Agent {
	command: string;
	provider?: string | undefined;
	config: AgentConfig;
}

export interface PriorityRule {
	command: string;
	provider?: string | undefined;
	model?: string | undefined;
	priority: number;
	weekdays?: string[] | undefined;
	hours?: string[] | undefined;
}

export interface Settings {
	agents: Agent[];
	priority: PriorityRule[];
}

export type AgentLimit =
	| { kind: "not_limited" }
	| { kind: "limited"; resetTime?: Date | undefined };

export interface AgentStatus {
	command: string;
	provider?: string | undefined;
	limit: AgentLimit;
}
