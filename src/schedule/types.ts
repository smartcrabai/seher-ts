// TODO(unit-merge): replace these local types with imports from `src/types.ts`
// once Unit 1 lands. Kept local to avoid coupling during parallel development.

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
	provider: ProviderConfig;
	active: ScheduleRule | null;
	inactive: ScheduleRule | null;
	models?: Record<string, unknown> | null;
}

export interface PriorityRule {
	command: string;
	provider: ProviderConfig;
	model: string | null;
	priority: number;
	weekdays?: string[];
	hours?: string[];
}
