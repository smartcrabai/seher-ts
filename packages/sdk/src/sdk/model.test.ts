import { describe, expect, test } from "bun:test";
import {
	EFFORT_LEVELS,
	type EffortLevel,
	effortToThinking,
	splitEffortSuffix,
	splitThinkingSuffix,
	type ThinkingLevel,
} from "./model.ts";

describe("splitThinkingSuffix", () => {
	test("strips a recognized canonical level and returns thinking", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:high")).toEqual({
			base: "claude-opus-4-5",
			thinking: "high",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:off")).toEqual({
			base: "claude-opus-4-5",
			thinking: "off",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:minimal")).toEqual({
			base: "claude-opus-4-5",
			thinking: "minimal",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:low")).toEqual({
			base: "claude-opus-4-5",
			thinking: "low",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:medium")).toEqual({
			base: "claude-opus-4-5",
			thinking: "medium",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:xhigh")).toEqual({
			base: "claude-opus-4-5",
			thinking: "xhigh",
		});
	});

	test("keeps the base intact and extracts thinking for provider/model form", () => {
		expect(splitThinkingSuffix("anthropic/claude-opus-4-5:high")).toEqual({
			base: "anthropic/claude-opus-4-5",
			thinking: "high",
		});
	});

	test("returns the original string unstripped for unrecognized suffixes (e.g. OpenRouter :free)", () => {
		expect(
			splitThinkingSuffix("openrouter/meta-llama/llama-3.1-8b-instruct:free"),
		).toEqual({
			base: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
		});
	});

	test("aliases: med -> medium, 1 -> low, 0 -> off, none -> off, min -> minimal", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:med")).toEqual({
			base: "claude-opus-4-5",
			thinking: "medium",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:1")).toEqual({
			base: "claude-opus-4-5",
			thinking: "low",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:0")).toEqual({
			base: "claude-opus-4-5",
			thinking: "off",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:none")).toEqual({
			base: "claude-opus-4-5",
			thinking: "off",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:min")).toEqual({
			base: "claude-opus-4-5",
			thinking: "minimal",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:2")).toEqual({
			base: "claude-opus-4-5",
			thinking: "medium",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:3")).toEqual({
			base: "claude-opus-4-5",
			thinking: "high",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:4")).toEqual({
			base: "claude-opus-4-5",
			thinking: "xhigh",
		});
	});

	test("recognizes suffixes with uppercase letters or surrounding whitespace", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:HIGH")).toEqual({
			base: "claude-opus-4-5",
			thinking: "high",
		});
		expect(splitThinkingSuffix("claude-opus-4-5: med ")).toEqual({
			base: "claude-opus-4-5",
			thinking: "medium",
		});
	});

	test("returns a model ID with no suffix unchanged as base", () => {
		expect(splitThinkingSuffix("claude-sonnet-4-5")).toEqual({
			base: "claude-sonnet-4-5",
		});
		expect(splitThinkingSuffix("anthropic/claude-sonnet-4-5")).toEqual({
			base: "anthropic/claude-sonnet-4-5",
		});
	});

	test("`:max` is recognized and stripped even though pi's ThinkingLevel has no max tier (regression test for model-id corruption)", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:max")).toEqual({
			base: "claude-opus-4-5",
			thinking: "max",
		});
		expect(splitThinkingSuffix("anthropic/claude-opus-4-5:MAX")).toEqual({
			base: "anthropic/claude-opus-4-5",
			thinking: "max",
		});
	});

	test("when there are multiple `:`, only the **last** one is considered", () => {
		// `:free:low` -> base=`llama-3.1:free`, thinking=low
		expect(splitThinkingSuffix("llama-3.1:free:low")).toEqual({
			base: "llama-3.1:free",
			thinking: "low",
		});
		// `:free:turbo` -> turbo is unrecognized, so it is not stripped
		expect(splitThinkingSuffix("llama-3.1:free:turbo")).toEqual({
			base: "llama-3.1:free:turbo",
		});
	});

	test("strips nothing when the string ends with `:` (empty trailing suffix)", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:")).toEqual({
			base: "claude-opus-4-5:",
		});
	});

	test("malformed `zai/glm/4.6:high` yields base=`zai/glm/4.6`, thinking=high", () => {
		expect(splitThinkingSuffix("zai/glm/4.6:high")).toEqual({
			base: "zai/glm/4.6",
			thinking: "high",
		});
	});

	test("property names inherited from Object.prototype are ignored unless they are own properties of the alias table", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:constructor")).toEqual({
			base: "claude-opus-4-5:constructor",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:toString")).toEqual({
			base: "claude-opus-4-5:toString",
		});
		expect(splitThinkingSuffix("claude-opus-4-5:__proto__")).toEqual({
			base: "claude-opus-4-5:__proto__",
		});
	});

	test("ThinkingLevel is a 6-value union (type-level smoke test)", () => {
		const levels: ThinkingLevel[] = [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		];
		expect(levels).toHaveLength(6);
	});
});

describe("splitEffortSuffix", () => {
	test("strips a recognized canonical level and returns effort", () => {
		expect(splitEffortSuffix("claude-opus-4-5:low")).toEqual({
			base: "claude-opus-4-5",
			effort: "low",
		});
		expect(splitEffortSuffix("claude-opus-4-5:medium")).toEqual({
			base: "claude-opus-4-5",
			effort: "medium",
		});
		expect(splitEffortSuffix("claude-opus-4-5:high")).toEqual({
			base: "claude-opus-4-5",
			effort: "high",
		});
		expect(splitEffortSuffix("claude-opus-4-5:xhigh")).toEqual({
			base: "claude-opus-4-5",
			effort: "xhigh",
		});
		expect(splitEffortSuffix("claude-opus-4-5:max")).toEqual({
			base: "claude-opus-4-5",
			effort: "max",
		});
	});

	test("keeps the base intact and extracts effort for provider/model form", () => {
		expect(splitEffortSuffix("anthropic/claude-opus-4-5:high")).toEqual({
			base: "anthropic/claude-opus-4-5",
			effort: "high",
		});
	});

	test("returns the original string unstripped for unrecognized suffixes (e.g. OpenRouter :free)", () => {
		expect(
			splitEffortSuffix("openrouter/meta-llama/llama-3.1-8b-instruct:free"),
		).toEqual({
			base: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
		});
	});

	test("aliases: med -> medium, 1 -> low, min -> low, minimal -> low (kept in sync with the Rust `effort_from_suffix` vocabulary)", () => {
		expect(splitEffortSuffix("claude-opus-4-5:med")).toEqual({
			base: "claude-opus-4-5",
			effort: "medium",
		});
		expect(splitEffortSuffix("claude-opus-4-5:1")).toEqual({
			base: "claude-opus-4-5",
			effort: "low",
		});
		expect(splitEffortSuffix("claude-opus-4-5:min")).toEqual({
			base: "claude-opus-4-5",
			effort: "low",
		});
		expect(splitEffortSuffix("claude-opus-4-5:minimal")).toEqual({
			base: "claude-opus-4-5",
			effort: "low",
		});
		expect(splitEffortSuffix("claude-opus-4-5:2")).toEqual({
			base: "claude-opus-4-5",
			effort: "medium",
		});
		expect(splitEffortSuffix("claude-opus-4-5:3")).toEqual({
			base: "claude-opus-4-5",
			effort: "high",
		});
		expect(splitEffortSuffix("claude-opus-4-5:4")).toEqual({
			base: "claude-opus-4-5",
			effort: "xhigh",
		});
	});

	test("`off`/`none`/`0` are recognized and stripped but have no EffortLevel equivalent", () => {
		// pi's "no extra thinking" tier has no matching `claude --effort` value,
		// so the suffix is still stripped from the model id (matching the Rust
		// `effort_from_suffix` split) but `effort` stays unset -- no `--effort`
		// flag should be emitted rather than guessing a tier.
		expect(splitEffortSuffix("claude-opus-4-5:off")).toEqual({
			base: "claude-opus-4-5",
		});
		expect(splitEffortSuffix("claude-opus-4-5:none")).toEqual({
			base: "claude-opus-4-5",
		});
		expect(splitEffortSuffix("claude-opus-4-5:0")).toEqual({
			base: "claude-opus-4-5",
		});
	});

	test("recognizes suffixes with uppercase letters or surrounding whitespace", () => {
		expect(splitEffortSuffix("claude-opus-4-5:HIGH")).toEqual({
			base: "claude-opus-4-5",
			effort: "high",
		});
		expect(splitEffortSuffix("claude-opus-4-5: medium ")).toEqual({
			base: "claude-opus-4-5",
			effort: "medium",
		});
	});

	test("property names inherited from Object.prototype are not misrecognized as effort", () => {
		expect(splitEffortSuffix("claude-opus-4-5:constructor")).toEqual({
			base: "claude-opus-4-5:constructor",
		});
		expect(splitEffortSuffix("claude-opus-4-5:toString")).toEqual({
			base: "claude-opus-4-5:toString",
		});
	});

	test("returns a model ID with no suffix unchanged as base", () => {
		expect(splitEffortSuffix("claude-sonnet-4-5")).toEqual({
			base: "claude-sonnet-4-5",
		});
		expect(splitEffortSuffix("anthropic/claude-sonnet-4-5")).toEqual({
			base: "anthropic/claude-sonnet-4-5",
		});
	});

	test("when there are multiple `:`, only the **last** one is considered", () => {
		// `:free:low` -> base=`llama-3.1:free`, effort=low
		expect(splitEffortSuffix("llama-3.1:free:low")).toEqual({
			base: "llama-3.1:free",
			effort: "low",
		});
		// `:free:turbo` -> turbo is unrecognized, so it is not stripped
		expect(splitEffortSuffix("llama-3.1:free:turbo")).toEqual({
			base: "llama-3.1:free:turbo",
		});
	});

	test("strips nothing when the string ends with `:` (empty trailing suffix)", () => {
		expect(splitEffortSuffix("claude-opus-4-5:")).toEqual({
			base: "claude-opus-4-5:",
		});
	});

	test("malformed `zai/glm/4.6:high` yields base=`zai/glm/4.6`, effort=high", () => {
		expect(splitEffortSuffix("zai/glm/4.6:high")).toEqual({
			base: "zai/glm/4.6",
			effort: "high",
		});
	});

	test("EFFORT_LEVELS is a 5-value union (type-level smoke test)", () => {
		const levels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
		expect(levels).toHaveLength(5);
		expect(EFFORT_LEVELS).toHaveLength(5);
		expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});
});

describe("effortToThinking", () => {
	test("maps low/medium/high/xhigh to the identically named pi thinking level", () => {
		expect(effortToThinking("low")).toBe("low");
		expect(effortToThinking("medium")).toBe("medium");
		expect(effortToThinking("high")).toBe("high");
		expect(effortToThinking("xhigh")).toBe("xhigh");
	});

	test("maps max to pi's highest tier, xhigh (pi has no max tier)", () => {
		expect(effortToThinking("max")).toBe("xhigh");
	});
});
