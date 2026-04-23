// TODO: merge with the shared `src/types.ts` once Unit 1 is integrated.
export type ProviderConfig =
	| { kind: "inferred" }
	| { kind: "explicit"; name: string }
	| { kind: "none" };

export interface AgentConfig {
	command: string;
	args: string[];
	models: Record<string, string> | null;
	arg_maps: Record<string, string[]>;
	env: Record<string, string> | null;
	provider: ProviderConfig;
	pre_command: string[];
	// other fields are defined in sibling units
}
