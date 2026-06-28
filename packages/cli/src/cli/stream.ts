import type { SeherSDK, SeherStreamChunk } from "@seher-ts/sdk";

export type WriteFn = (text: string) => void;

export interface StreamToStdoutOptions {
	prompt: string;
	systemPrompt?: string;
	/** Per-run timeout (ms). Forwarded to `sdk.stream({ timeoutMs })`. */
	timeoutMs?: number;
	/** Session id to resume; forwarded straight through to `sdk.stream()`. */
	resume?: string;
	/** Callback used for stdout deltas. Defaults to `process.stdout.write`. */
	write?: WriteFn;
	/** Append a trailing newline once streaming is done. Defaults to `true`. */
	trailingNewline?: boolean;
}

export interface StreamToStdoutResult {
	/** Concatenated assistant text. */
	text: string;
	/**
	 * Session id reported by the underlying SDK, when available. The CLI uses
	 * this to print `session: <id>` to stderr so a follow-up turn can resume.
	 */
	sessionId?: string;
}

/**
 * Pump a SeherSDK stream() into stdout, writing one delta at a time and
 * optionally appending a final newline. Returns the full concatenated text
 * plus the SDK-reported session id (so callers can keep a copy without
 * re-running the stream and can echo the id for multi-turn resume).
 */
export async function streamToStdout(
	sdk: SeherSDK,
	opts: StreamToStdoutOptions,
): Promise<StreamToStdoutResult> {
	const write = opts.write ?? ((text: string) => process.stdout.write(text));
	const buf: string[] = [];
	const runOpts: {
		prompt: string;
		systemPrompt?: string;
		timeoutMs?: number;
		resume?: string;
	} = {
		prompt: opts.prompt,
	};
	if (opts.systemPrompt !== undefined) runOpts.systemPrompt = opts.systemPrompt;
	if (opts.timeoutMs !== undefined) runOpts.timeoutMs = opts.timeoutMs;
	if (opts.resume !== undefined) runOpts.resume = opts.resume;
	for await (const chunk of sdk.stream(
		runOpts,
	) as AsyncIterable<SeherStreamChunk>) {
		if (chunk.delta.length === 0) continue;
		buf.push(chunk.delta);
		write(chunk.delta);
	}
	const trailingNewline = opts.trailingNewline ?? true;
	if (trailingNewline) write("\n");
	const out: StreamToStdoutResult = { text: buf.join("") };
	const sessionId = sdk.lastSessionId();
	if (sessionId !== undefined && sessionId.length > 0)
		out.sessionId = sessionId;
	return out;
}
