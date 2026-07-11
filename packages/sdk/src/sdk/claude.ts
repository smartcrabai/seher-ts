import {
	createSdkMcpServer,
	type EffortLevel,
	type Options,
	type PermissionMode,
	query,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";

import { assertValidResumeId, LimitError } from "./errors.ts";
import { splitEffortSuffix } from "./model.ts";
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
	if (typeof reset === "number") {
		// resetsAt is unix epoch seconds; Date expects milliseconds. Values
		// above 1e12 are already milliseconds (defensive: ~33658 CE as seconds).
		opts.resetAt = new Date(reset < 1e12 ? reset * 1000 : reset);
	}
	return new LimitError("claude", opts);
}

export interface ClaudeSDKConfig {
	apiKey?: string;
	baseURL?: string;
	defaultModel?: string;
	/**
	 * Default value for `Options.effort`. Takes precedence over a `:level`
	 * suffix on the model ID (e.g. `claude-opus-4-5:high`), which is only used
	 * as a fallback when this is unset.
	 */
	effortLevel?: EffortLevel;
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
		const rawModel = opts.model ?? this.config.defaultModel;
		let suffixEffort: EffortLevel | undefined;
		if (rawModel !== undefined) {
			// A trailing `:level` suffix on the model ID (e.g. `claude-opus-4-5:high`)
			// is mapped to `Options.effort`. An unrecognized suffix like `:free`
			// is left in the base instead of being stripped.
			const { base, effort } = splitEffortSuffix(rawModel);
			options.model = base;
			suffixEffort = effort;
		}
		// config.effortLevel (explicit / config-resolved) takes precedence over
		// a model-id suffix, which is only a fallback.
		const effectiveEffort = this.config.effortLevel ?? suffixEffort;
		if (effectiveEffort !== undefined) options.effort = effectiveEffort;
		if (opts.systemPrompt !== undefined) {
			options.systemPrompt = opts.systemPrompt;
		}
		if (this.config.cwd !== undefined) options.cwd = this.config.cwd;
		// Resuming an existing session. The Claude Agent SDK directly supports
		// `Options.resume`. To let the id shown via `session: <id>` be passed
		// through unchanged next time, we thread the CLI / upper-layer SDK's
		// `--resume` down to here. We also validate at the SDK layer to guard
		// against a malicious id (path traversal / flag injection) on direct
		// SDK calls.
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
		// Always reset at the start so `lastSessionId()` doesn't mistakenly
		// expose an id left over from a previous run/stream. It's overwritten
		// on the spot if a session_id is observed during the run, and stays
		// undefined if none is observed.
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
				// session_id rides along on assistant/system/result messages alike.
				// It can be observed at least once via assistant before the final
				// result, but `result.session_id` is the most authoritative, so we
				// overwrite with the result's value.
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
				// As with run(), clear the previous id at the start.
				self._lastSessionId = undefined;
				const q = query({
					prompt: opts.prompt,
					options: self.buildOptions(opts),
				});
				for await (const message of q) {
					const limit = tryLimitFromMessage(message);
					if (limit !== null) throw limit;
					// Pick up session_id from every message type (assistant/system/result/...).
					// stream() itself doesn't carry the session id on chunks, so we keep
					// it as SDK-side state, retrievable via `lastSessionId()`.
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
