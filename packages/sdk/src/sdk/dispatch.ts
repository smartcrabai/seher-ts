/**
 * `dispatch` API: 解決済み {@link ResolvedAgent} 向けの低レベル実行ヘルパー。
 *
 * SeherSDK は YAML の解決から実行まで一気通貫で扱う高レベル API なのに対し、
 * dispatch API は CodexBar / `resolveAgent` を呼んで既に `ResolvedAgent` を
 * 手元に持っているコードのための薄いルーティング層。
 *
 * Rust 側の `seher-sdk` の `dispatch::stream_for_resolved` /
 * `dispatch::run_for_resolved` に対応する。
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
 * Rust 側の `RunAgentOptions` 相当のオプション。
 *
 * `kind` を指定しない `SeherSDK` 経由ではなく `ResolvedAgent` を直接持っている
 * 呼び出し元向け。tool 非対応の SDK kind に対して非空の `tools` を渡すと
 * `runForResolved` / `streamForResolved` のいずれもエラーを throw する。
 */
export interface RunForResolvedOptions {
	/** 実行するプロンプト本文。 */
	prompt: string;
	/** 追加で付与するシステムプロンプト。 */
	systemPrompt?: string;
	/** 関数呼び出し用に登録するツール群。tool 非対応 kind では throw する。 */
	tools?: SeherTool[];
	/** ランナーの実行タイムアウト(ms)。 */
	timeoutMs?: number;
	/** `ResolvedAgent.api.key` を上書きする API key。 */
	apiKey?: string;
	/** `ResolvedAgent.api.endpoint` を上書きする base URL。 */
	baseURL?: string;
	/** 実行時の cwd。 */
	cwd?: string;
	/** マルチターン継続用の session id。 */
	resume?: string;
	/** SDK に渡す追加環境変数。 */
	env?: Record<string, string>;
}

/**
 * tool 非対応 kind に tools を渡したことを伝えるエラー。
 *
 * Rust 側の `DispatchError::ToolsNotSupported` 相当。
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
	// `systemPrompt` は SDK インスタンス毎の設定ではなく per-call の
	// `SeherRunOptions` で渡すため、ここでは扱わない (Rust 側の
	// `RunAgentOptions.system_prompt` がランナー設定に積まれるのと等価)。
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
 * 解決済み {@link ResolvedAgent} に対してプロンプトを実行し、最終結果を返す。
 *
 * Rust 側の `dispatch::run_for_resolved` 相当の低レベル API。`SeherSDK` の
 * `resolveAgent` を済ませている呼び出し元が、解決ロジックを再走させずに
 * 同じ `ResolvedAgent` で複数回 run/stream を実行したい場合に使う。
 *
 * tool 非対応 SDK kind (`pi` / `claude` / `copilot` / `kimi` 以外) に対して
 * 非空の `tools` を渡した場合は {@link DispatchToolsNotSupportedError} を throw する。
 */
export async function runForResolved(
	agent: ResolvedAgent,
	opts: RunForResolvedOptions,
): Promise<SeherRunResult> {
	ensureToolsSupported(agent, opts.tools);
	const merged = applyResolvedAgent(agent.kind, buildBaseConfig(opts), agent);
	const instance = buildInstance(agent.kind, merged);
	const runOpts = buildRunOptions(agent, opts);
	// 注: `opts.resume` は Rust 側の API シグネチャに合わせて受け取っているが、
	// 現状の `SeherSDKInstance` は単発実行のみで multi-turn セッション再開を
	// 持たないため、今は forward 先がなく無視される。
	return instance.run(runOpts);
}

/**
 * 解決済み {@link ResolvedAgent} に対してプロンプトをストリーミング実行する。
 *
 * Rust 側の `dispatch::stream_for_resolved` 相当の低レベル API。tool 非対応
 * SDK kind に非空の `tools` を渡した場合は AsyncIterable の最初の `next()` で
 * {@link DispatchToolsNotSupportedError} を throw する。
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
