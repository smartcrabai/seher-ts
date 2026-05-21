import { describe, expect, test } from "bun:test";
import { buildClaudeCommand } from "./command.ts";

describe("buildClaudeCommand", () => {
	test("emits --permission-mode with the provided mode", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				permissionMode: "bypassPermissions",
			}),
		).toEqual(["claude", "--permission-mode", "bypassPermissions"]);
	});

	test("appends --model when provided", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				model: "claude-opus-4-7",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"claude",
			"--model",
			"claude-opus-4-7",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("appends --append-system-prompt when systemPrompt is provided", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				systemPrompt: "You are concise.",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"claude",
			"--append-system-prompt",
			"You are concise.",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("forwards a non-bypass permission mode verbatim", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				permissionMode: "default",
			}),
		).toEqual(["claude", "--permission-mode", "default"]);
	});

	test("combines all options in stable order", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "/opt/claude",
				model: "claude-sonnet-4-6",
				systemPrompt: "sys",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"/opt/claude",
			"--model",
			"claude-sonnet-4-6",
			"--append-system-prompt",
			"sys",
			"--permission-mode",
			"bypassPermissions",
		]);
	});
});
