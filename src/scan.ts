import type { AgentLimit } from "./types.ts";

export type ScanResult =
	| { kind: "available"; index: number }
	| { kind: "all_limited"; minReset: Date }
	| { kind: "no_agents" };

export type CheckLimitFn<A> = (agent: A, index: number) => Promise<AgentLimit>;

/**
 * Scan the agents in priority order. Returns the first `not_limited` agent,
 * or the earliest reset time if all are `limited`, or `no_agents` if the list
 * is empty or all checks errored without reset times.
 *
 * Ported from Rust `cli::scan_candidates`.
 */
export async function scanCandidates<A>(
	agents: A[],
	checkLimit: CheckLimitFn<A>,
): Promise<ScanResult> {
	if (agents.length === 0) {
		return { kind: "no_agents" };
	}

	const resets: Date[] = [];
	for (let i = 0; i < agents.length; i++) {
		const agent = agents[i];
		if (agent === undefined) continue;
		let limit: AgentLimit;
		try {
			limit = await checkLimit(agent, i);
		} catch {
			continue;
		}
		if (limit.kind === "not_limited") {
			return { kind: "available", index: i };
		}
		resets.push(limit.resetTime);
	}

	if (resets.length === 0) {
		return { kind: "no_agents" };
	}

	let min = resets[0] as Date;
	for (const d of resets) {
		if (d.getTime() < min.getTime()) min = d;
	}
	return { kind: "all_limited", minReset: min };
}
