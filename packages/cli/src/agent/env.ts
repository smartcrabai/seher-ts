/**
 * Merge a base environment (usually `process.env`) with the agent-specific
 * overrides. Entries whose value is `undefined` are dropped so the returned
 * map is safe to pass to `Bun.spawn`.
 */
export function buildEnv(
	base: Record<string, string | undefined>,
	agentEnv: Record<string, string> | null,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) {
			out[key] = value;
		}
	}
	if (agentEnv !== null) {
		for (const [key, value] of Object.entries(agentEnv)) {
			out[key] = value;
		}
	}
	return out;
}
