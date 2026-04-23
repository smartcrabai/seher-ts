// TODO(merge): replace with the shared definition from `src/types.ts`
// once Unit 1 merges. Kept local to avoid cross-unit coupling during the
// parallel port.
export type AgentLimit =
	| { kind: "not_limited" }
	| { kind: "limited"; resetTime: Date };
