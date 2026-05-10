import type { SeherSDK, SeherStreamChunk } from "@seher-ts/sdk";

export type WriteFn = (text: string) => void;

export interface StreamToStdoutOptions {
	prompt: string;
	systemPrompt?: string;
	/** Callback used for stdout deltas. Defaults to `process.stdout.write`. */
	write?: WriteFn;
	/** Append a trailing newline once streaming is done. Defaults to `true`. */
	trailingNewline?: boolean;
}

/**
 * Pump a SeherSDK stream() into stdout, writing one delta at a time and
 * optionally appending a final newline. Returns the full concatenated text
 * (so callers can keep a copy without re-running the stream).
 */
export async function streamToStdout(
	sdk: SeherSDK,
	opts: StreamToStdoutOptions,
): Promise<string> {
	const write = opts.write ?? ((text: string) => process.stdout.write(text));
	const buf: string[] = [];
	const runOpts: { prompt: string; systemPrompt?: string } = {
		prompt: opts.prompt,
	};
	if (opts.systemPrompt !== undefined) runOpts.systemPrompt = opts.systemPrompt;
	for await (const chunk of sdk.stream(
		runOpts,
	) as AsyncIterable<SeherStreamChunk>) {
		if (chunk.delta.length === 0) continue;
		buf.push(chunk.delta);
		write(chunk.delta);
	}
	const trailingNewline = opts.trailingNewline ?? true;
	if (trailingNewline) write("\n");
	return buf.join("");
}
