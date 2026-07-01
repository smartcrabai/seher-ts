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

	test("combines all options including effortLevel and resume in stable order", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "/opt/claude",
				model: "claude-sonnet-4-6",
				effortLevel: "high",
				systemPrompt: "sys",
				resume: "session-id",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"/opt/claude",
			"--model",
			"claude-sonnet-4-6",
			"--effort",
			"high",
			"--append-system-prompt",
			"sys",
			"--resume",
			"session-id",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("認識可能な effort サフィックスは strip して `--model` に base のみを渡し `--effort` として転送する", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				model: "claude-opus-4-5:high",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"claude",
			"--model",
			"claude-opus-4-5",
			"--effort",
			"high",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("認識できないサフィックス(`:free` 等)は原文のまま `--model` に渡す", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				model: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"claude",
			"--model",
			"openrouter/meta-llama/llama-3.1-8b-instruct:free",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("model に effort サフィックスがなければ effortLevel を `--effort` として転送する", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				model: "claude-opus-4-5",
				effortLevel: "medium",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"claude",
			"--model",
			"claude-opus-4-5",
			"--effort",
			"medium",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("model の effort サフィックスが effortLevel より優先される", () => {
		expect(
			buildClaudeCommand({
				claudeBin: "claude",
				model: "claude-opus-4-5:high",
				effortLevel: "medium",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"claude",
			"--model",
			"claude-opus-4-5",
			"--effort",
			"high",
			"--permission-mode",
			"bypassPermissions",
		]);
	});
});
