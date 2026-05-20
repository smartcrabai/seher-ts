import { extractTextBlocks } from "../text.ts";
import type { ClaudeTerminalResponse, TranscriptMessage } from "./types.ts";

/**
 * Extract a single text response from a Claude transcript response.
 *
 * Preference order:
 *   1. `result.result` (final answer emitted by Claude Code at end of turn)
 *   2. Concatenated text blocks from all assistant messages (in order)
 *   3. Empty string
 *
 * Tool-use blocks and other non-text content are ignored.
 */
export function normalizeText(response: ClaudeTerminalResponse): string {
	const last = response.lastResultMessage;
	if (
		last !== undefined &&
		last.type === "result" &&
		typeof last.result === "string" &&
		last.result.length > 0
	) {
		return last.result;
	}
	const parts: string[] = [];
	for (const msg of response.assistantMessages) {
		const text = textFromAssistantMessage(msg);
		if (text.length > 0) parts.push(text);
	}
	return parts.join("");
}

function textFromAssistantMessage(msg: TranscriptMessage): string {
	if (msg.type !== "assistant") return "";
	const content = msg.message?.content;
	if (typeof content === "string") return content;
	return extractTextBlocks(content);
}
