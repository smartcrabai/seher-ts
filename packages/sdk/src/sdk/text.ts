type TextBlockLike = { type?: string; text?: string };

/**
 * Concatenate `text` fields from blocks shaped like `{ type, text }` arrays,
 * keeping only entries with `type === "text"`. Used by Claude, OpenCode, and
 * Cursor runners — each one's SDK returns a similar shape.
 */
export function extractTextBlocks(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	const parts: string[] = [];
	for (const block of blocks as TextBlockLike[]) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("");
}

/**
 * Prepend a system prompt as a leading paragraph for SDKs that don't accept
 * a separate system message channel (Codex, Kimi, Cursor).
 */
export function joinSystemPrompt(opts: {
	prompt: string;
	systemPrompt?: string;
}): string {
	return opts.systemPrompt !== undefined
		? `${opts.systemPrompt}\n\n${opts.prompt}`
		: opts.prompt;
}
