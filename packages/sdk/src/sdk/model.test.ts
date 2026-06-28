import { describe, expect, test } from "bun:test";
import { splitThinkingSuffix, type ThinkingLevel } from "./model.ts";

describe("splitThinkingSuffix", () => {
	test("認識可能な canonical level を strip して thinking を返す", () => {
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

	test("provider/model 形式でも base を保持しつつ thinking を取り出す", () => {
		expect(splitThinkingSuffix("anthropic/claude-opus-4-5:high")).toEqual({
			base: "anthropic/claude-opus-4-5",
			thinking: "high",
		});
	});

	test("認識できないサフィックスは strip せず原文を返す (OpenRouter :free など)", () => {
		expect(
			splitThinkingSuffix("openrouter/meta-llama/llama-3.1-8b-instruct:free"),
		).toEqual({
			base: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
		});
	});

	test("エイリアス: med は medium、1 は low、0 は off、none も off、min は minimal", () => {
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

	test("大文字や前後空白を含むサフィックスも認識する", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:HIGH")).toEqual({
			base: "claude-opus-4-5",
			thinking: "high",
		});
		expect(splitThinkingSuffix("claude-opus-4-5: med ")).toEqual({
			base: "claude-opus-4-5",
			thinking: "medium",
		});
	});

	test("サフィックスを持たないモデル ID はそのまま base に返す", () => {
		expect(splitThinkingSuffix("claude-sonnet-4-5")).toEqual({
			base: "claude-sonnet-4-5",
		});
		expect(splitThinkingSuffix("anthropic/claude-sonnet-4-5")).toEqual({
			base: "anthropic/claude-sonnet-4-5",
		});
	});

	test("複数の `:` がある場合は **最後** の `:` のみを判定する", () => {
		// `:free:low` -> base=`llama-3.1:free`, thinking=low
		expect(splitThinkingSuffix("llama-3.1:free:low")).toEqual({
			base: "llama-3.1:free",
			thinking: "low",
		});
		// `:free:turbo` -> turbo は不明なので strip しない
		expect(splitThinkingSuffix("llama-3.1:free:turbo")).toEqual({
			base: "llama-3.1:free:turbo",
		});
	});

	test("`:` で終わる(末尾サフィックス空)場合は何も strip しない", () => {
		expect(splitThinkingSuffix("claude-opus-4-5:")).toEqual({
			base: "claude-opus-4-5:",
		});
	});

	test("奇形 `zai/glm/4.6:high` は base=`zai/glm/4.6`, thinking=high", () => {
		expect(splitThinkingSuffix("zai/glm/4.6:high")).toEqual({
			base: "zai/glm/4.6",
			thinking: "high",
		});
	});

	test("ThinkingLevel 型は 6 値の union (型レベル smoke test)", () => {
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
