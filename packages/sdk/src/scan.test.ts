import { describe, expect, test } from "bun:test";
import { scanCandidates } from "./scan.ts";
import type { AgentLimit } from "./types.ts";

interface TestAgent {
	command: string;
}

function mkAgent(command: string): TestAgent {
	return { command };
}

describe("scanCandidates", () => {
	test("returns no_agents for empty input", async () => {
		const result = await scanCandidates([], async () => ({
			kind: "not_limited",
		}));
		expect(result.kind).toBe("no_agents");
	});

	test("returns first available agent", async () => {
		const agents = [mkAgent("a"), mkAgent("b"), mkAgent("c")];
		const checked: string[] = [];
		const result = await scanCandidates<TestAgent>(
			agents,
			async (agent, idx) => {
				checked.push(agent.command);
				return idx === 1
					? ({ kind: "not_limited" } as AgentLimit)
					: ({
							kind: "limited",
							resetTime: new Date("2099-01-01T00:00:00Z"),
						} as AgentLimit);
			},
		);
		expect(result).toEqual({ kind: "available", index: 1 });
		// Stops at first available.
		expect(checked).toEqual(["a", "b"]);
	});

	test("returns earliest reset when all limited", async () => {
		const agents = [mkAgent("a"), mkAgent("b"), mkAgent("c")];
		const early = new Date("2030-01-01T00:00:00Z");
		const mid = new Date("2030-01-02T00:00:00Z");
		const late = new Date("2030-01-03T00:00:00Z");
		const resets = [late, early, mid];
		const result = await scanCandidates<TestAgent>(
			agents,
			async (_agent, idx) => ({
				kind: "limited",
				resetTime: resets[idx] as Date,
			}),
		);
		expect(result).toEqual({ kind: "all_limited", minReset: early });
	});

	test("continues past errors", async () => {
		const agents = [mkAgent("a"), mkAgent("b")];
		const result = await scanCandidates<TestAgent>(
			agents,
			async (_agent, idx) => {
				if (idx === 0) throw new Error("boom");
				return { kind: "not_limited" };
			},
		);
		expect(result).toEqual({ kind: "available", index: 1 });
	});

	test("returns no_agents when all errored", async () => {
		const agents = [mkAgent("a")];
		const result = await scanCandidates<TestAgent>(agents, async () => {
			throw new Error("boom");
		});
		expect(result.kind).toBe("no_agents");
	});
});
