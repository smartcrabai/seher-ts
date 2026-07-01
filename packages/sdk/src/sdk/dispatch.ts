/**
 * `dispatch` API: low-level execution helpers for an already-resolved
 * {@link ResolvedAgent}.
 *
 * `SeherSDK` is the high-level API that handles everything from YAML
 * resolution through execution in one go, whereas the dispatch API is a
 * thin routing layer for code that has already called `resolveAgent` and
 * holds a `ResolvedAgent` on hand.
 *
 * This mirrors `dispatch::stream_for_resolved` /
 * `dispatch::run_for_resolved` on the Rust side of `seher-sdk`.
 */

import type { ResolvedAgent } from "../types.ts";
import { TOOL_SUPPORTING_KINDS } from "./resolve.ts";
import {
	applyResolvedAgent,
	buildInstance,
	type SeherSDKConfig,
} from "./seherSdk.ts";
import type { SeherTool } from "./tools.ts";
import type {
	SeherRunOptions,
	SeherRunResult,
	SeherStreamChunk,
} from "./types.ts";

/**
 * Options equivalent to `RunAgentOptions` on the Rust side.
 *
 * Intended for callers that already hold a `ResolvedAgent` directly, rather
 * than going through `SeherSDK` with a `kind`. Passing non-empty `tools` for
 * an SDK kind that doesn't support tools makes both `runForResolved` and
 * `streamForResolved` throw.
 */
export interface RunForResolvedOptions {
	/** The prompt text to run. */
	prompt: string;
	/** Additional system prompt to attach. */
	systemPrompt?: string;
	/** Tools to register for function calling. Throws for tool-unsupported kinds. */
	tools?: SeherTool[];
	/** Execution timeout for the runner, in ms. */
	timeoutMs?: number;
	/** API key that overrides `ResolvedAgent.api.key`. */
	apiKey?: string;
	/** Base URL that overrides `ResolvedAgent.api.endpoint`. */
	baseURL?: string;
	/** Working directory to run in. */
	cwd?: string;
	/** Session id used to resume a multi-turn conversation. */
	resume?: string;
	/** Extra environment variables to pass to the SDK. */
	env?: Record<string, string>;
}

/**
 * Error indicating that `tools` was passed for a kind that doesn't support
 * them.
 *
 * Equivalent to `DispatchError::ToolsNotSupported` on the Rust side.
 */
export class DispatchToolsNotSupportedError extends Error {
	readonly kind: string;
	constructor(kind: string) {
		super(`sdk '${kind}' does not support custom tools`);
		this.name = "DispatchToolsNotSupportedError";
		this.kind = kind;
	}
}

function ensureToolsSupported(
	agent: ResolvedAgent,
	tools: SeherTool[] | undefined,
): void {
	if (tools === undefined || tools.length === 0) return;
	if (TOOL_SUPPORTING_KINDS.has(agent.kind)) return;
	throw new DispatchToolsNotSupportedError(agent.kind);
}

function buildBaseConfig(opts: RunForResolvedOptions): SeherSDKConfig {
	// `systemPrompt` is not handled here since it's passed per-call via
	// `SeherRunOptions` rather than as part of the SDK instance config
	// (equivalent to how `RunAgentOptions.system_prompt` gets folded into the
	// runner config on the Rust side).
	const base: SeherSDKConfig = {};
	if (opts.tools !== undefined) base.tools = opts.tools;
	if (opts.timeoutMs !== undefined) base.timeoutMs = opts.timeoutMs;
	if (opts.apiKey !== undefined) base.apiKey = opts.apiKey;
	if (opts.baseURL !== undefined) base.baseURL = opts.baseURL;
	if (opts.cwd !== undefined) base.cwd = opts.cwd;
	if (opts.env !== undefined) base.env = { ...opts.env };
	return base;
}

function buildRunOptions(
	agent: ResolvedAgent,
	opts: RunForResolvedOptions,
): SeherRunOptions {
	const runOpts: SeherRunOptions = {
		prompt: opts.prompt,
		model: agent.modelId,
	};
	if (opts.systemPrompt !== undefined) runOpts.systemPrompt = opts.systemPrompt;
	if (opts.timeoutMs !== undefined) runOpts.timeoutMs = opts.timeoutMs;
	return runOpts;
}

/**
 * Runs a prompt against an already-resolved {@link ResolvedAgent} and
 * returns the final result.
 *
 * This is the low-level API equivalent to `dispatch::run_for_resolved` on
 * the Rust side. Use it when a caller has already gone through `SeherSDK`'s
 * `resolveAgent` and wants to run/stream multiple times against the same
 * `ResolvedAgent` without re-running the resolution logic.
 *
 * Throws {@link DispatchToolsNotSupportedError} if non-empty `tools` is
 * passed for an SDK kind that doesn't support tools (anything other than
 * `pi` / `claude` / `copilot` / `kimi`).
 */
export async function runForResolved(
	agent: ResolvedAgent,
	opts: RunForResolvedOptions,
): Promise<SeherRunResult> {
	ensureToolsSupported(agent, opts.tools);
	const merged = applyResolvedAgent(agent.kind, buildBaseConfig(opts), agent);
	const instance = buildInstance(agent.kind, merged);
	const runOpts = buildRunOptions(agent, opts);
	// Note: `opts.resume` is accepted here to match the Rust-side API
	// signature, but the current `SeherSDKInstance` only supports single-shot
	// execution and has no multi-turn session resumption, so there's nowhere
	// to forward it to and it's ignored for now.
	return instance.run(runOpts);
}

/**
 * Streams a prompt against an already-resolved {@link ResolvedAgent}.
 *
 * This is the low-level API equivalent to `dispatch::stream_for_resolved` on
 * the Rust side. If non-empty `tools` is passed for an SDK kind that doesn't
 * support tools, {@link DispatchToolsNotSupportedError} is thrown on the
 * first `next()` call of the AsyncIterable.
 */
export function streamForResolved(
	agent: ResolvedAgent,
	opts: RunForResolvedOptions,
): AsyncIterable<SeherStreamChunk> {
	return {
		async *[Symbol.asyncIterator]() {
			ensureToolsSupported(agent, opts.tools);
			const merged = applyResolvedAgent(
				agent.kind,
				buildBaseConfig(opts),
				agent,
			);
			const instance = buildInstance(agent.kind, merged);
			const runOpts = buildRunOptions(agent, opts);
			for await (const chunk of instance.stream(runOpts)) {
				yield chunk;
			}
		},
	};
}
