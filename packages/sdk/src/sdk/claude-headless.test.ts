import { describe, expect, test } from "bun:test";
import { buildClaudeArgs } from "./claude-headless.ts";
import { isClaudeRateLimitMessage } from "./errors.ts";

describe("buildClaudeArgs", () => {
	test("minimal: prompt only (Rust: build_args_minimal)", () => {
		expect(
			buildClaudeArgs({
				prompt: "hello",
				permissionMode: "bypassPermissions",
			}),
		).toEqual(["-p", "hello", "--permission-mode", "bypassPermissions"]);
	});

	test("appends --model after the prompt", () => {
		expect(
			buildClaudeArgs({
				prompt: "hello",
				model: "claude-sonnet-4-6",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"-p",
			"hello",
			"--model",
			"claude-sonnet-4-6",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("appends --append-system-prompt when systemPrompt is provided", () => {
		expect(
			buildClaudeArgs({
				prompt: "hello",
				systemPrompt: "Be concise.",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"-p",
			"hello",
			"--append-system-prompt",
			"Be concise.",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("prepends --resume <id> when a session id is provided (Rust: build_args_with_resume)", () => {
		expect(
			buildClaudeArgs({
				prompt: "hello",
				resume: "abc-123",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"--resume",
			"abc-123",
			"-p",
			"hello",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("model + systemPrompt combine in Rust-compatible order (Rust: build_args_with_model_and_system)", () => {
		expect(
			buildClaudeArgs({
				prompt: "hello",
				model: "claude-sonnet-4-6",
				systemPrompt: "Be concise.",
				permissionMode: "bypassPermissions",
			}),
		).toEqual([
			"-p",
			"hello",
			"--model",
			"claude-sonnet-4-6",
			"--append-system-prompt",
			"Be concise.",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("full: resume + model + systemPrompt + non-default permission mode", () => {
		expect(
			buildClaudeArgs({
				prompt: "hello",
				resume: "abc-123",
				model: "claude-opus-4-7",
				systemPrompt: "Be concise.",
				permissionMode: "default",
			}),
		).toEqual([
			"--resume",
			"abc-123",
			"-p",
			"hello",
			"--model",
			"claude-opus-4-7",
			"--append-system-prompt",
			"Be concise.",
			"--permission-mode",
			"default",
		]);
	});
});

describe("isClaudeRateLimitMessage", () => {
	test("matches 'rate limit'", () => {
		expect(isClaudeRateLimitMessage("Error: rate limit exceeded")).toBe(true);
	});

	test("matches 'usage limit'", () => {
		expect(isClaudeRateLimitMessage("usage limit")).toBe(true);
	});

	test("matches 'too many requests' case-insensitively", () => {
		expect(isClaudeRateLimitMessage("Too Many Requests")).toBe(true);
	});

	test("matches 'session limit'", () => {
		expect(isClaudeRateLimitMessage("session limit reached")).toBe(true);
	});

	test("returns false for regular text", () => {
		expect(isClaudeRateLimitMessage("regular text")).toBe(false);
	});

	test("returns false for the empty string", () => {
		expect(isClaudeRateLimitMessage("")).toBe(false);
	});
});
