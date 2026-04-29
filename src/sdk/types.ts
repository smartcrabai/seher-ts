export type SdkKind = "claude" | "codex" | "copilot" | "kimi";

export interface SeherRunOptions {
	prompt: string;
	model?: string;
	systemPrompt?: string;
	maxTokens?: number;
}

export interface SeherRunResult {
	text: string;
	kind: SdkKind;
	raw: unknown;
}

export interface SeherStreamChunk {
	kind: SdkKind;
	delta: string;
	raw: unknown;
}

/**
 * Common contract implemented by the per-provider SDK classes (`ClaudeSDK`,
 * `CodexSDK`). The public entry point `SeherSDK` (in `seherSdk.ts`) is a
 * higher-level class that wraps one of these instances.
 */
export interface SeherSDKInstance {
	readonly kind: SdkKind;
	run(opts: SeherRunOptions): Promise<SeherRunResult>;
	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk>;
}
