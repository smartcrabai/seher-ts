// TODO(unit-1): merge into src/types.ts once Unit 1 lands the shared type module.

export type ProviderConfig =
	| { kind: "inferred" }
	| { kind: "explicit"; name: string }
	| { kind: "none" };

export type ScheduleRule = {
	weekdays?: string[];
	hours?: string[];
};

export interface AgentConfig {
	command: string;
	args: string[];
	models: Record<string, string> | null;
	arg_maps: Record<string, string[]>;
	env: Record<string, string> | null;
	provider: ProviderConfig;
	openrouter_management_key?: string;
	glm_api_key?: string;
	pre_command: string[];
	active: ScheduleRule | null;
	inactive: ScheduleRule | null;
	sdk?: "claude" | "codex" | null;
}

export interface PriorityRule {
	command: string;
	provider: ProviderConfig;
	model: string | null;
	priority: number;
	weekdays?: string[];
	hours?: string[];
}

export interface Settings {
	priority: PriorityRule[];
	agents: AgentConfig[];
}
