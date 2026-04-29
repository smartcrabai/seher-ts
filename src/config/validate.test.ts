import { describe, expect, test } from "bun:test";
import { ConfigValidationError, validateSettings } from "./validate.ts";

describe("validateSettings", () => {
	test("minimal input parses", () => {
		const s = validateSettings({ agents: [{ command: "claude" }] });
		expect(s.agents).toHaveLength(1);
		const a = s.agents[0];
		expect(a).toBeDefined();
		if (!a) return;
		expect(a.command).toBe("claude");
		expect(a.args).toEqual([]);
		expect(a.models).toBeNull();
		expect(a.arg_maps).toEqual({});
		expect(a.env).toBeNull();
		expect(a.provider).toEqual({ kind: "inferred" });
		expect(a.pre_command).toEqual([]);
		expect(a.active).toBeNull();
		expect(a.inactive).toBeNull();
		expect(s.priority).toEqual([]);
	});

	test("provider three-state: absent/explicit/null", () => {
		const s = validateSettings({
			agents: [
				{ command: "a" },
				{ command: "b", provider: "copilot" },
				{ command: "c", provider: null },
			],
		});
		expect(s.agents[0]?.provider).toEqual({ kind: "inferred" });
		expect(s.agents[1]?.provider).toEqual({
			kind: "explicit",
			name: "copilot",
		});
		expect(s.agents[2]?.provider).toEqual({ kind: "none" });
	});

	test("rejects active+inactive on same agent", () => {
		expect(() =>
			validateSettings({
				agents: [
					{
						command: "claude",
						active: { hours: ["9-17"] },
						inactive: { hours: ["0-8"] },
					},
				],
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects weekday range out of 0-6", () => {
		expect(() =>
			validateSettings({
				agents: [{ command: "claude", active: { weekdays: ["1-8"] } }],
			}),
		).toThrow(/weekdays range/);
	});

	test("rejects weekday range with start > end", () => {
		expect(() =>
			validateSettings({
				agents: [{ command: "claude", active: { weekdays: ["5-3"] } }],
			}),
		).toThrow(/start must not exceed end/);
	});

	test("rejects empty active schedule", () => {
		expect(() =>
			validateSettings({
				agents: [{ command: "claude", active: {} }],
			}),
		).toThrow(/at least one of weekdays or hours/);
	});

	test("rejects hour range >48", () => {
		expect(() =>
			validateSettings({
				agents: [{ command: "claude", active: { hours: ["0-49"] } }],
			}),
		).toThrow(/end must not exceed 48/);
	});

	test("rejects hour range with start >= end", () => {
		expect(() =>
			validateSettings({
				agents: [{ command: "claude", active: { hours: ["5-5"] } }],
			}),
		).toThrow(/start must be less than end/);
	});

	test("accepts hour range >24 as next-day wrap", () => {
		const s = validateSettings({
			agents: [{ command: "claude", active: { hours: ["21-27"] } }],
		});
		expect(s.agents[0]?.active?.hours).toEqual(["21-27"]);
	});

	test("accepts weekday single day (start == end)", () => {
		const s = validateSettings({
			agents: [{ command: "claude", active: { weekdays: ["3-3"] } }],
		});
		expect(s.agents[0]?.active?.weekdays).toEqual(["3-3"]);
	});

	test("rejects malformed range string", () => {
		expect(() =>
			validateSettings({
				agents: [{ command: "claude", active: { hours: ["abc"] } }],
			}),
		).toThrow(/invalid hours range/);
	});

	test("priority.priority must be a number", () => {
		expect(() =>
			validateSettings({
				agents: [{ command: "claude" }],
				priority: [{ command: "claude", priority: "high" }],
			}),
		).toThrow(/priority\[0\]\.priority/);
	});

	test("priority fields: provider/model optional, weekdays/hours validated", () => {
		const s = validateSettings({
			agents: [{ command: "claude" }],
			priority: [
				{
					command: "claude",
					provider: null,
					model: "high",
					priority: 100,
					weekdays: ["1-5"],
					hours: ["9-17"],
				},
				{ command: "codex", priority: 50 },
			],
		});
		expect(s.priority).toHaveLength(2);
		expect(s.priority[0]?.provider).toEqual({ kind: "none" });
		expect(s.priority[0]?.model).toBe("high");
		expect(s.priority[0]?.priority).toBe(100);
		expect(s.priority[0]?.weekdays).toEqual(["1-5"]);
		expect(s.priority[1]?.provider).toEqual({ kind: "inferred" });
		expect(s.priority[1]?.model).toBeNull();
	});

	test("agent.command missing fails with label", () => {
		expect(() => validateSettings({ agents: [{ args: ["x"] }] })).toThrow(
			/agents\[0\]\.command/,
		);
	});

	test("agents must be array", () => {
		expect(() => validateSettings({ agents: {} })).toThrow(/settings\.agents/);
	});

	test("sdk accepts claude/codex/copilot/kimi/null, rejects others", () => {
		const s = validateSettings({
			agents: [
				{ command: "a", sdk: "claude" },
				{ command: "b", sdk: "codex" },
				{ command: "c", sdk: "copilot" },
				{ command: "d", sdk: "kimi" },
				{ command: "e", sdk: null },
			],
		});
		expect(s.agents[0]?.sdk).toBe("claude");
		expect(s.agents[1]?.sdk).toBe("codex");
		expect(s.agents[2]?.sdk).toBe("copilot");
		expect(s.agents[3]?.sdk).toBe("kimi");
		expect(s.agents[4]?.sdk).toBeNull();
		expect(() =>
			validateSettings({ agents: [{ command: "x", sdk: "other" }] }),
		).toThrow(/sdk/);
	});
});
