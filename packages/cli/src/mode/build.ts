import {
	type EffortLevel,
	SeherSDK,
	type SeherSDKOptions,
} from "@seher-ts/sdk";
import { streamToStdout, type WriteFn } from "../cli/stream.ts";
import type { Logger } from "../util/logger.ts";
import { applyRetryHooks } from "../util/retry.ts";

export interface BuildModeOptions {
	prompt: string;
	mode?: string;
	provider?: string;
	model?: string;
	configPath?: string;
	timeoutMs?: number;
	effortLevel?: EffortLevel;
	quiet?: boolean;
	systemPrompt?: string;
	/** Canonicalized working directory for the agent. */
	cwd?: string;
	/** Session id to resume; passed straight through to the underlying SDK. */
	resume?: string;
	logger: Logger;
	/** Optional pre-constructed SDK (for plan-mode reuse / tests). */
	sdk?: SeherSDK;
	/** Optional stdout write override (tests). */
	write?: WriteFn;
}

export interface BuildModeResult {
	exitCode: number;
	text: string;
	/**
	 * Session id reported by the underlying SDK for this run. Only populated
	 * for SDKs that own multi-turn sessions; callers typically suppress the
	 * `session: <id>` stderr print when `resume` was given.
	 */
	sessionId?: string;
}

function buildSdkOptions(opts: BuildModeOptions): SeherSDKOptions {
	const out: SeherSDKOptions = {};
	const mode = opts.mode ?? "build";
	out.mode = mode;
	if (opts.provider !== undefined) out.provider = opts.provider;
	if (opts.configPath !== undefined) out.configPath = opts.configPath;
	if (opts.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
	if (opts.cwd !== undefined) out.cwd = opts.cwd;
	if (opts.effortLevel !== undefined) out.effortLevel = opts.effortLevel;
	// Claude SDK: enable yolo by default for CLI agents.
	out.permissionMode = "bypassPermissions";
	applyRetryHooks(out, opts.logger);
	return out;
}

export async function runBuildMode(
	opts: BuildModeOptions,
): Promise<BuildModeResult> {
	const sdk = opts.sdk ?? new SeherSDK(buildSdkOptions(opts));
	if (!opts.quiet) {
		const { kind, agent } = await sdk.resolved();
		const label =
			agent !== null ? `${agent.provider} (${kind}/${agent.modelId})` : kind;
		opts.logger.info(`Selected provider: ${label}`);
	}
	const streamOpts: Parameters<typeof streamToStdout>[1] = {
		prompt: opts.prompt,
	};
	if (opts.systemPrompt !== undefined)
		streamOpts.systemPrompt = opts.systemPrompt;
	if (opts.timeoutMs !== undefined) streamOpts.timeoutMs = opts.timeoutMs;
	if (opts.resume !== undefined) streamOpts.resume = opts.resume;
	if (opts.write !== undefined) streamOpts.write = opts.write;
	const { text, sessionId } = await streamToStdout(sdk, streamOpts);
	const result: BuildModeResult = { exitCode: 0, text };
	if (sessionId !== undefined) result.sessionId = sessionId;
	return result;
}
