import { describe, expect, test } from "bun:test";
import { normalizeText } from "./response-normalizer.ts";
import type { ClaudeTerminalResponse, TranscriptMessage } from "./types.ts";

function asMsg(m: TranscriptMessage): TranscriptMessage {
	return m;
}

describe("normalizeText", () => {
	test("prefers `result.result` when present", () => {
		const response: ClaudeTerminalResponse = {
			sessionId: "s1",
			assistantMessages: [
				asMsg({
					type: "assistant",
					message: { content: [{ type: "text", text: "draft" }] },
				}),
			],
			lastResultMessage: asMsg({
				type: "result",
				subtype: "success",
				result: "final answer",
			}),
		};
		expect(normalizeText(response)).toBe("final answer");
	});

	test("concatenates text blocks from assistant messages when no result", () => {
		const response: ClaudeTerminalResponse = {
			sessionId: "s1",
			assistantMessages: [
				asMsg({
					type: "assistant",
					message: {
						content: [
							{ type: "text", text: "Hello, " },
							{ type: "tool_use", name: "Read" },
							{ type: "text", text: "world" },
						],
					},
				}),
				asMsg({
					type: "assistant",
					message: { content: [{ type: "text", text: "!" }] },
				}),
			],
		};
		expect(normalizeText(response)).toBe("Hello, world!");
	});

	test("handles plain string content", () => {
		const response: ClaudeTerminalResponse = {
			sessionId: "s1",
			assistantMessages: [
				asMsg({ type: "assistant", message: { content: "raw text" } }),
			],
		};
		expect(normalizeText(response)).toBe("raw text");
	});

	test("returns empty string when no usable content", () => {
		const response: ClaudeTerminalResponse = {
			sessionId: "s1",
			assistantMessages: [],
		};
		expect(normalizeText(response)).toBe("");
	});

	test("falls back to assistant text if `result.result` is empty", () => {
		const response: ClaudeTerminalResponse = {
			sessionId: "s1",
			assistantMessages: [
				asMsg({
					type: "assistant",
					message: { content: [{ type: "text", text: "fallback" }] },
				}),
			],
			lastResultMessage: asMsg({
				type: "result",
				subtype: "success",
				result: "",
			}),
		};
		expect(normalizeText(response)).toBe("fallback");
	});
});
