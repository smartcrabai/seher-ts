import { describe, expect, test } from "bun:test";
import { buildClaudeCommand } from "./command.ts";

describe("buildClaudeCommand", () => {
	test("returns the bin alone when no extras are set", () => {
		expect(buildClaudeCommand({ claudeBin: "claude" })).toEqual(["claude"]);
	});

	test("appends --model when provided", () => {
		expect(
			buildClaudeCommand({ claudeBin: "claude", model: "claude-opus-4-7" }),
		).toEqual(["claude", "--model", "claude-opus-4-7"]);
	});

	test("appends --append-system-prompt when systemPrompt is provided", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				systemPrompt: "You are concise.",
			}),
		).toEqual(["claude", "--append-system-prompt", "You are concise."]);
	});

	test("appends --dangerously-skip-permissions when flag is true", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				dangerouslySkipPermissions: true,
			}),
		).toEqual(["claude", "--dangerously-skip-permissions"]);
	});

	test("combines all options in stable order", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "/opt/claude",
				model: "claude-sonnet-4-6",
				systemPrompt: "sys",
				dangerouslySkipPermissions: true,
			}),
		).toEqual([
			"/opt/claude",
			"--model",
			"claude-sonnet-4-6",
			"--append-system-prompt",
			"sys",
			"--dangerously-skip-permissions",
		]);
	});
});
