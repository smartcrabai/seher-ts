export type SdkKind = "claude" | "codex";

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

export interface SeherSDK {
	readonly kind: SdkKind;
	run(opts: SeherRunOptions): Promise<SeherRunResult>;
	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk>;
}
