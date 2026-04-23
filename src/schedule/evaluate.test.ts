import { describe, expect, test } from "bun:test";
import { isScheduleActive } from "./evaluate.ts";
import { agentIsUsable, priorityRuleMatches } from "./ruleMatch.ts";
import type { AgentConfig, PriorityRule } from "./types.ts";

function at(year: number, monthIndex: number, day: number, hour: number): Date {
	return new Date(year, monthIndex, day, hour, 0, 0, 0);
}

describe("isScheduleActive", () => {
	test("no weekdays and no hours => always true", () => {
		expect(isScheduleActive({}, at(2024, 0, 1, 9))).toBe(true);
	});

	test('weekdays "1-5" matches Monday 09:00', () => {
		// 2024-01-01 is a Monday.
		expect(isScheduleActive({ weekdays: ["1-5"] }, at(2024, 0, 1, 9))).toBe(
			true,
		);
	});

	test('weekdays "1-5" excludes Saturday', () => {
		// 2024-01-06 is a Saturday.
		expect(isScheduleActive({ weekdays: ["1-5"] }, at(2024, 0, 6, 12))).toBe(
			false,
		);
	});

	test('hours "21-27" includes 22:00', () => {
		expect(isScheduleActive({ hours: ["21-27"] }, at(2024, 0, 1, 22))).toBe(
			true,
		);
	});

	test('hours "21-27" includes next-day 02:00', () => {
		expect(isScheduleActive({ hours: ["21-27"] }, at(2024, 0, 2, 2))).toBe(
			true,
		);
	});

	test('hours "21-27" excludes 04:00', () => {
		expect(isScheduleActive({ hours: ["21-27"] }, at(2024, 0, 2, 4))).toBe(
			false,
		);
	});

	test("weekdays + hours both required", () => {
		// Monday 22:00 with Mon-Fri + 21-27
		expect(
			isScheduleActive(
				{ weekdays: ["1-5"], hours: ["21-27"] },
				at(2024, 0, 1, 22),
			),
		).toBe(true);
		// Saturday 22:00 with Mon-Fri + 21-27
		expect(
			isScheduleActive(
				{ weekdays: ["1-5"], hours: ["21-27"] },
				at(2024, 0, 6, 22),
			),
		).toBe(false);
	});

	test("overnight hours reference previous weekday", () => {
		// Sunday 02:00 with weekdays Mon-Fri + hours 21-27 => prev day was Saturday -> false.
		// 2024-01-07 is Sunday.
		expect(
			isScheduleActive(
				{ weekdays: ["1-5"], hours: ["21-27"] },
				at(2024, 0, 7, 2),
			),
		).toBe(false);
		// Tuesday 02:00 with same rule => prev day was Monday -> true.
		expect(
			isScheduleActive(
				{ weekdays: ["1-5"], hours: ["21-27"] },
				at(2024, 0, 2, 2),
			),
		).toBe(true);
	});

	test("malformed range strings are ignored", () => {
		expect(isScheduleActive({ weekdays: ["bad"] }, at(2024, 0, 1, 9))).toBe(
			false,
		);
		expect(isScheduleActive({ hours: ["x-y"] }, at(2024, 0, 1, 9))).toBe(false);
	});
});

describe("agentIsUsable", () => {
	const base: AgentConfig = {
		command: "claude",
		provider: { kind: "inferred" },
		active: null,
		inactive: null,
	};

	test("no active/inactive => always usable", () => {
		expect(agentIsUsable(base, at(2024, 0, 1, 9))).toBe(true);
	});

	test("active gate: within window usable, outside not", () => {
		const agent: AgentConfig = { ...base, active: { weekdays: ["1-5"] } };
		expect(agentIsUsable(agent, at(2024, 0, 1, 9))).toBe(true);
		expect(agentIsUsable(agent, at(2024, 0, 6, 9))).toBe(false);
	});

	test("inactive gate: within window NOT usable, outside usable", () => {
		const agent: AgentConfig = { ...base, inactive: { weekdays: ["1-5"] } };
		expect(agentIsUsable(agent, at(2024, 0, 1, 9))).toBe(false);
		expect(agentIsUsable(agent, at(2024, 0, 6, 9))).toBe(true);
	});

	test("both set: active AND not-inactive", () => {
		const agent: AgentConfig = {
			...base,
			active: { weekdays: ["1-5"] },
			inactive: { hours: ["12-13"] },
		};
		expect(agentIsUsable(agent, at(2024, 0, 1, 9))).toBe(true);
		expect(agentIsUsable(agent, at(2024, 0, 1, 12))).toBe(false);
	});
});

describe("priorityRuleMatches", () => {
	const agent: AgentConfig = {
		command: "claude",
		provider: { kind: "inferred" },
		active: null,
		inactive: null,
	};

	test("matches on command + provider + null model", () => {
		const rule: PriorityRule = {
			command: "claude",
			provider: { kind: "inferred" },
			model: null,
			priority: 10,
		};
		expect(priorityRuleMatches(rule, agent, null, at(2024, 0, 1, 9))).toBe(
			true,
		);
		// A selected model when rule specifies null should NOT match.
		expect(priorityRuleMatches(rule, agent, "sonnet", at(2024, 0, 1, 9))).toBe(
			false,
		);
	});

	test("mismatched command returns false", () => {
		const rule: PriorityRule = {
			command: "codex",
			provider: { kind: "inferred" },
			model: null,
			priority: 5,
		};
		expect(priorityRuleMatches(rule, agent, null, at(2024, 0, 1, 9))).toBe(
			false,
		);
	});

	test("schedule conditions constrain match", () => {
		const rule: PriorityRule = {
			command: "claude",
			provider: { kind: "inferred" },
			model: null,
			priority: 10,
			weekdays: ["1-5"],
		};
		expect(priorityRuleMatches(rule, agent, null, at(2024, 0, 1, 9))).toBe(
			true,
		);
		expect(priorityRuleMatches(rule, agent, null, at(2024, 0, 6, 9))).toBe(
			false,
		);
	});

	test("explicit provider matching", () => {
		const explicitAgent: AgentConfig = {
			...agent,
			provider: { kind: "explicit", name: "custom" },
		};
		const rule: PriorityRule = {
			command: "claude",
			provider: { kind: "explicit", name: "custom" },
			model: null,
			priority: 1,
		};
		expect(
			priorityRuleMatches(rule, explicitAgent, null, at(2024, 0, 1, 9)),
		).toBe(true);

		const otherRule: PriorityRule = {
			...rule,
			provider: { kind: "explicit", name: "other" },
		};
		expect(
			priorityRuleMatches(otherRule, explicitAgent, null, at(2024, 0, 1, 9)),
		).toBe(false);
	});
});
