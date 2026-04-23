import { describe, expect, test } from "bun:test";
import type { AgentConfig, PriorityRule } from "../types.ts";
import { priorityForAgent, sortByPriority } from "./sort.ts";

function makeAgent(command: string, providerName?: string): AgentConfig {
	return {
		command,
		args: [],
		models: null,
		arg_maps: {},
		env: null,
		provider: providerName
			? { kind: "explicit", name: providerName }
			: { kind: "inferred" },
		pre_command: [],
		active: null,
		inactive: null,
	};
}

function at(year: number, monthIndex: number, day: number, hour: number): Date {
	return new Date(year, monthIndex, day, hour, 0, 0, 0);
}

describe("sortByPriority", () => {
	const claudeAgent = makeAgent("claude");
	const codexAgent = makeAgent("codex");
	const copilotAgent = makeAgent("opencode", "copilot");

	const priorities: PriorityRule[] = [
		{
			command: "codex",
			provider: { kind: "inferred" },
			model: null,
			priority: 100,
		},
		{
			command: "claude",
			provider: { kind: "inferred" },
			model: null,
			priority: 50,
		},
		{
			command: "opencode",
			provider: { kind: "explicit", name: "copilot" },
			model: null,
			priority: 10,
		},
	];

	test("sorts agents by descending priority", () => {
		const ordered = sortByPriority(
			[claudeAgent, codexAgent, copilotAgent],
			priorities,
			null,
			at(2024, 0, 1, 9),
		);
		expect(ordered.map((a) => a.command)).toEqual([
			"codex",
			"claude",
			"opencode",
		]);
	});

	test("ties preserve original order (stable)", () => {
		const a = makeAgent("claude");
		const b = makeAgent("codex");
		// no priority rules matching => both priority 0
		const ordered = sortByPriority([a, b], [], null, at(2024, 0, 1, 9));
		expect(ordered[0]).toBe(a);
		expect(ordered[1]).toBe(b);
	});

	test("schedule-gated rule only applies inside window", () => {
		const claude = makeAgent("claude");
		const codex = makeAgent("codex");
		// Inside window: codex is boosted.
		const windowedPriorities: PriorityRule[] = [
			{
				command: "codex",
				provider: { kind: "inferred" },
				model: null,
				priority: 100,
				weekdays: ["1-5"],
			},
			{
				command: "claude",
				provider: { kind: "inferred" },
				model: null,
				priority: 50,
			},
		];
		const monday = at(2024, 0, 1, 9);
		const saturday = at(2024, 0, 6, 9);
		expect(
			sortByPriority([claude, codex], windowedPriorities, null, monday).map(
				(a) => a.command,
			),
		).toEqual(["codex", "claude"]);
		expect(
			sortByPriority([claude, codex], windowedPriorities, null, saturday).map(
				(a) => a.command,
			),
		).toEqual(["claude", "codex"]);
	});

	test("priority rule with model=null only matches when no model selected", () => {
		const claude = makeAgent("claude");
		const rules: PriorityRule[] = [
			{
				command: "claude",
				provider: { kind: "inferred" },
				model: null,
				priority: 50,
			},
		];
		expect(priorityForAgent(rules, claude, null, at(2024, 0, 1, 9))).toBe(50);
		expect(priorityForAgent(rules, claude, "sonnet", at(2024, 0, 1, 9))).toBe(
			0,
		);
	});

	test("more specific schedule rule wins over less specific", () => {
		const claude = makeAgent("claude");
		const rules: PriorityRule[] = [
			{
				command: "claude",
				provider: { kind: "inferred" },
				model: null,
				priority: 10,
			},
			{
				command: "claude",
				provider: { kind: "inferred" },
				model: null,
				priority: 99,
				weekdays: ["1-5"],
				hours: ["8-18"],
			},
		];
		expect(priorityForAgent(rules, claude, null, at(2024, 0, 1, 9))).toBe(99);
		// Outside specific window, fall back to generic.
		expect(priorityForAgent(rules, claude, null, at(2024, 0, 6, 9))).toBe(10);
	});
});
