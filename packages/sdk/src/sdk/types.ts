import type { SdkKind } from "../types.ts";

export type { SeherTool } from "./tools.ts";
export type { SdkKind };

export interface SeherRunOptions {
	prompt: string;
	model?: string;
	systemPrompt?: string;
	maxTokens?: number;
	/** Per-call timeout (ms); overrides instance `timeoutMs`. Does NOT abort in-flight provider work. */
	timeoutMs?: number;
	/**
	 * Resume an existing multi-turn session by id. The id is the value printed
	 * as `session: <id>` on a previous run. The backend that owns the id is
	 * inferred by the calling layer; passing a foreign id is a no-op for SDKs
	 * that do not support session resume.
	 */
	resume?: string;
}

export interface SeherRunResult {
	text: string;
	kind: SdkKind;
	raw: unknown;
	/**
	 * Session id for this turn — surfaced so a caller can persist it (e.g.
	 * stderr `session: <id>` print) and reuse it on the next run via
	 * `SeherRunOptions.resume`. Only populated by SDKs that own multi-turn
	 * sessions (`claude`, `claude-terminal`, `pi`). For fresh runs this is a
	 * new id; on resume it echoes back the provided one.
	 */
	sessionId?: string;
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
	/**
	 * Session id of the most recent `run()` / `stream()` call, if the
	 * underlying SDK owns multi-turn sessions. Reset to `undefined` whenever
	 * the SDK's internal session is disposed/cleared. SDKs that don't carry
	 * sessions (e.g. codex, copilot, cursor, kimi, opencode) always return
	 * `undefined`.
	 */
	lastSessionId?(): string | undefined;
}
