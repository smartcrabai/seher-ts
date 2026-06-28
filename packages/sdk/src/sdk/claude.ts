import {
	createSdkMcpServer,
	type Options,
	type PermissionMode,
	query,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { assertValidResumeId, LimitError } from "./errors.ts";
import { extractTextBlocks } from "./text.ts";
import { withStreamTimeout, withTimeout } from "./timeout.ts";
import type { SeherTool } from "./tools.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

type RateLimitEventLike = {
	type: "rate_limit_event";
	rate_limit_info?: {
		status?: string;
		resetsAt?: number;
		overageStatus?: string;
		overageResetsAt?: number;
	};
};

function tryLimitFromMessage(message: unknown): LimitError | null {
	if (
		message === null ||
		typeof message !== "object" ||
		(message as { type?: unknown }).type !== "rate_limit_event"
	) {
		return null;
	}
	const info = (message as RateLimitEventLike).rate_limit_info;
	if (info === undefined) return null;
	if (info.status !== "rejected" && info.overageStatus !== "rejected") {
		return null;
	}
	const opts: ConstructorParameters<typeof LimitError>[1] = {
		provider: "claude",
	};
	const reset = info.resetsAt ?? info.overageResetsAt;
	if (typeof reset === "number") opts.resetAt = new Date(reset);
	return new LimitError("claude", opts);
}

export interface ClaudeSDKConfig {
	apiKey?: string;
	baseURL?: string;
	defaultModel?: string;
	/** Permission mode for the Claude agent. `"auto"` uses a model classifier. */
	permissionMode?: PermissionMode;
	cwd?: string;
	/**
	 * Extra environment variables forwarded to the spawned Claude agent process.
	 * `apiKey` / `baseURL` (translated to `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`)
	 * take precedence over keys with the same name set here.
	 */
	env?: Record<string, string>;
	/** Default `run()` / `stream()` timeout in ms. Per-call: `SeherRunOptions.timeoutMs`. */
	timeoutMs?: number;
	/**
	 * In-process tools registered via SeherSDK. Forwarded to the Claude agent
	 * as an SDK MCP server (`mcpServers.seher_tools`).
	 */
	tools?: SeherTool<z.ZodObject<z.ZodRawShape>>[];
}

function toClaudeTool(t: SeherTool<z.ZodObject<z.ZodRawShape>>) {
	return tool(
		t.name,
		t.description,
		t.parameters.shape,
		async (args: Record<string, unknown>) => {
			const text = await t.handler(args as never);
			return { content: [{ type: "text" as const, text }] };
		},
	);
}

const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
const SEHER_TOOLS_MCP_NAME = "seher_tools";

export class ClaudeSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "claude";
	private readonly config: ClaudeSDKConfig;
	private readonly mcpServers: Options["mcpServers"];
	private _lastSessionId: string | undefined;

	lastSessionId(): string | undefined {
		return this._lastSessionId;
	}

	constructor(config: ClaudeSDKConfig = {}) {
		this.config = config;
		const tools = config.tools;
		this.mcpServers =
			tools !== undefined && tools.length > 0
				? {
						[SEHER_TOOLS_MCP_NAME]: createSdkMcpServer({
							name: SEHER_TOOLS_MCP_NAME,
							tools: tools.map(toClaudeTool),
						}),
					}
				: undefined;
	}

	private buildOptions(opts: SeherRunOptions): Options {
		const permissionMode =
			this.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
		const options: Options = {
			permissionMode,
			settingSources: ["user", "project"],
		};
		if (permissionMode === "bypassPermissions") {
			options.allowDangerouslySkipPermissions = true;
		}
		const model = opts.model ?? this.config.defaultModel;
		if (model !== undefined) options.model = model;
		if (opts.systemPrompt !== undefined) {
			options.systemPrompt = opts.systemPrompt;
		}
		if (this.config.cwd !== undefined) options.cwd = this.config.cwd;
		// 既存セッションの継続。Claude Agent SDK は `Options.resume` を直接サポート
		// する。`session: <id>` で表示した id を次回そのまま渡せるよう、CLI / 上位
		// SDK の `--resume` をここまで通す経路を確保する。SDK 直接呼び出しでの不正な
		// id (path traversal / フラグ偽装) を防ぐため、SDK 層でも validate する。
		if (opts.resume !== undefined) {
			assertValidResumeId(opts.resume);
			options.resume = opts.resume;
		}

		const env: Record<string, string> = { ...(this.config.env ?? {}) };
		if (this.config.apiKey !== undefined) {
			env.ANTHROPIC_API_KEY = this.config.apiKey;
		}
		if (this.config.baseURL !== undefined) {
			env.ANTHROPIC_BASE_URL = this.config.baseURL;
		}
		if (Object.keys(env).length > 0) options.env = env;

		if (this.mcpServers !== undefined) options.mcpServers = this.mcpServers;

		return options;
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
		// 前回の run/stream で残った id を `lastSessionId()` が誤って晒さないよう、
		// 開始時に必ずリセットする。run 中に session_id が観測されればその場で
		// 上書きされ、観測されなければ undefined のまま終わる。
		this._lastSessionId = undefined;
		const work = (async (): Promise<SeherRunResult> => {
			const q = query({
				prompt: opts.prompt,
				options: this.buildOptions(opts),
			});
			let text = "";
			let raw: unknown;
			let sessionId: string | undefined;
			for await (const message of q) {
				const limit = tryLimitFromMessage(message);
				if (limit !== null) throw limit;
				// session_id は assistant/system/result どのメッセージにも乗ってくる。
				// 最終 result までに少なくとも 1 度は assistant でも観測できるが、
				// `result.session_id` が最も権威があるため、result の値で上書きする。
				const candidate = (message as { session_id?: unknown }).session_id;
				if (typeof candidate === "string" && candidate.length > 0) {
					sessionId = candidate;
				}
				if (message.type === "result") {
					raw = message;
					if (message.subtype === "success") text = message.result;
					break;
				}
			}
			const result: SeherRunResult = { text, kind: this.kind, raw };
			if (sessionId !== undefined) {
				result.sessionId = sessionId;
				this._lastSessionId = sessionId;
			}
			return result;
		})();
		return withTimeout(work, timeoutMs, this.kind);
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		const timeoutMs = opts.timeoutMs ?? self.config.timeoutMs;
		const source: AsyncIterable<SeherStreamChunk> = {
			async *[Symbol.asyncIterator]() {
				// run() と同様、開始時に直前の id をクリアする。
				self._lastSessionId = undefined;
				const q = query({
					prompt: opts.prompt,
					options: self.buildOptions(opts),
				});
				for await (const message of q) {
					const limit = tryLimitFromMessage(message);
					if (limit !== null) throw limit;
					// session_id を全 message 種別から拾う (assistant/system/result/...)。
					// stream() 自体は session id を chunk に乗せないので、SDK 側に状態として
					// 保持し、`lastSessionId()` 経由で取り出せるようにする。
					const candidate = (message as { session_id?: unknown }).session_id;
					if (typeof candidate === "string" && candidate.length > 0) {
						self._lastSessionId = candidate;
					}
					if (message.type !== "assistant") continue;
					const delta = extractTextBlocks(message.message.content);
					if (delta.length === 0) continue;
					yield { kind: self.kind, delta, raw: message };
				}
			},
		};
		return withStreamTimeout(source, timeoutMs, self.kind);
	}
}
