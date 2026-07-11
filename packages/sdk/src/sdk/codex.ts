import {
	type ApprovalMode,
	Codex,
	type ModelReasoningEffort,
	type SandboxMode,
} from "@openai/codex-sdk";
import { rethrowAsLimit } from "./errors.ts";
import type { EffortLevel } from "./model.ts";
import { joinSystemPrompt } from "./text.ts";
import { withTimeout } from "./timeout.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

const CODEX_LIMIT_PATTERN =
	/rate.?limit|usage.?limit|429|quota|too many requests/i;

function isCodexLimit(err: unknown): boolean {
	return err instanceof Error && CODEX_LIMIT_PATTERN.test(err.message);
}

/**
 * `CodexOptions.env`, when provided, replaces `process.env` entirely rather
 * than layering on top of it (unlike most other backends here). Since seher
 * config's `env` is meant to add/override a few keys, not replace the whole
 * environment, this explicitly merges `process.env` as the base before
 * `extra` is applied on top.
 */
function mergeWithProcessEnv(
	extra: Record<string, string>,
): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) merged[key] = value;
	}
	Object.assign(merged, extra);
	return merged;
}

export interface CodexSDKConfig {
	apiKey?: string;
	defaultModel?: string;
	sandboxMode?: SandboxMode;
	approvalPolicy?: ApprovalMode;
	/**
	 * Reasoning effort forwarded to `ThreadOptions.modelReasoningEffort`.
	 * `max` has no native Codex tier and is rounded down to `xhigh`.
	 */
	effortLevel?: EffortLevel;
	/**
	 * Extra environment variables forwarded to the Codex subprocess. Per
	 * `CodexOptions.env`'s own docs, specifying it means the process does
	 * *not* inherit `process.env`, so this is always merged as
	 * `{...process.env, ...env}` before being passed to the `Codex`
	 * constructor.
	 */
	env?: Record<string, string>;
	/** Default `run()` / `stream()` timeout in ms. Per-call: `SeherRunOptions.timeoutMs`. */
	timeoutMs?: number;
}

// seher-ts delegates safety to the caller, so default to maximally permissive.
const DEFAULT_SANDBOX_MODE: SandboxMode = "danger-full-access";
const DEFAULT_APPROVAL_POLICY: ApprovalMode = "never";

/**
 * Maps `EffortLevel` to Codex's native `ModelReasoningEffort`. `max` has no
 * direct equivalent and is rounded down to `xhigh` (Codex's highest tier).
 */
function effortToModelReasoningEffort(
	effort: EffortLevel,
): ModelReasoningEffort {
	switch (effort) {
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "xhigh";
	}
}

type CodexThreadOptions = NonNullable<Parameters<Codex["startThread"]>[0]>;

type ThreadItemLike = { type?: string; text?: string };
type RunResultLike = {
	finalResponse?: unknown;
	items?: unknown;
};

function extractFinalText(result: unknown): string {
	if (result === null || typeof result !== "object") return "";
	const r = result as RunResultLike;
	if (typeof r.finalResponse === "string" && r.finalResponse.length > 0) {
		return r.finalResponse;
	}
	if (Array.isArray(r.items)) {
		const messages: string[] = [];
		for (const item of r.items as ThreadItemLike[]) {
			if (
				item &&
				item.type === "agent_message" &&
				typeof item.text === "string"
			) {
				messages.push(item.text);
			}
		}
		if (messages.length > 0) return messages.join("");
	}
	return "";
}

export class CodexSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "codex";
	private readonly config: CodexSDKConfig;
	private _client: Codex | null = null;

	constructor(config: CodexSDKConfig = {}) {
		this.config = config;
	}

	private get client(): Codex {
		if (this._client === null) {
			const opts: { apiKey?: string; env?: Record<string, string> } = {};
			if (this.config.apiKey !== undefined) opts.apiKey = this.config.apiKey;
			if (
				this.config.env !== undefined &&
				Object.keys(this.config.env).length > 0
			) {
				opts.env = mergeWithProcessEnv(this.config.env);
			}
			this._client = new Codex(opts);
		}
		return this._client;
	}

	private startThread(opts: SeherRunOptions) {
		const threadOpts: CodexThreadOptions = {
			sandboxMode: this.config.sandboxMode ?? DEFAULT_SANDBOX_MODE,
			approvalPolicy: this.config.approvalPolicy ?? DEFAULT_APPROVAL_POLICY,
		};
		const model = opts.model ?? this.config.defaultModel;
		if (model !== undefined) threadOpts.model = model;
		if (this.config.effortLevel !== undefined) {
			threadOpts.modelReasoningEffort = effortToModelReasoningEffort(
				this.config.effortLevel,
			);
		}
		return this.client.startThread(threadOpts);
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
		const work = (async (): Promise<SeherRunResult> => {
			const thread = this.startThread(opts);
			let result: unknown;
			try {
				result = await thread.run(joinSystemPrompt(opts));
			} catch (err) {
				rethrowAsLimit("codex", err, isCodexLimit);
			}
			const text = extractFinalText(result);
			return { text, kind: this.kind, raw: result };
		})();
		return withTimeout(work, timeoutMs, this.kind);
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				// run() already enforces the timeout; no need to re-wrap.
				const result = await self.run(opts);
				yield { kind: self.kind, delta: result.text, raw: result.raw };
			},
		};
	}
}
