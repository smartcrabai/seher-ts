import { SeherSDK, type SeherSDKOptions } from "@seher-ts/sdk";
import { streamToStdout, type WriteFn } from "../cli/stream.ts";
import type { Logger } from "../util/logger.ts";

export interface BuildModeOptions {
	prompt: string;
	mode?: string;
	provider?: string;
	model?: string;
	configPath?: string;
	quiet?: boolean;
	systemPrompt?: string;
	logger: Logger;
	/** Optional pre-constructed SDK (for plan-mode reuse / tests). */
	sdk?: SeherSDK;
	/** Optional stdout write override (tests). */
	write?: WriteFn;
}

export interface BuildModeResult {
	exitCode: number;
	text: string;
}

function buildSdkOptions(opts: BuildModeOptions): SeherSDKOptions {
	const out: SeherSDKOptions = {};
	const mode = opts.mode ?? "build";
	out.mode = mode;
	if (opts.provider !== undefined) out.provider = opts.provider;
	if (opts.configPath !== undefined) out.configPath = opts.configPath;
	// Claude SDK: enable yolo by default for CLI agents.
	out.permissionMode = "bypassPermissions";
	return out;
}

export async function runBuildMode(
	opts: BuildModeOptions,
): Promise<BuildModeResult> {
	const sdk = opts.sdk ?? new SeherSDK(buildSdkOptions(opts));
	if (!opts.quiet) {
		const { kind, agent } = await sdk.resolved();
		const label =
			agent !== null ? `${agent.providerKey} (${kind}/${agent.modelId})` : kind;
		opts.logger.info(`Selected provider: ${label}`);
	}
	const streamOpts: Parameters<typeof streamToStdout>[1] = {
		prompt: opts.prompt,
	};
	if (opts.systemPrompt !== undefined)
		streamOpts.systemPrompt = opts.systemPrompt;
	if (opts.write !== undefined) streamOpts.write = opts.write;
	const text = await streamToStdout(sdk, streamOpts);
	return { exitCode: 0, text };
}
