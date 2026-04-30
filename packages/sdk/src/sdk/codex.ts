import { type ApprovalMode, Codex, type SandboxMode } from "@openai/codex-sdk";
import { joinSystemPrompt } from "./text.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

export interface CodexSDKConfig {
	apiKey?: string;
	defaultModel?: string;
	sandboxMode?: SandboxMode;
	approvalPolicy?: ApprovalMode;
}

// seher-ts delegates safety to the caller, so default to maximally permissive.
const DEFAULT_SANDBOX_MODE: SandboxMode = "danger-full-access";
const DEFAULT_APPROVAL_POLICY: ApprovalMode = "never";

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
			const opts: { apiKey?: string } = {};
			if (this.config.apiKey !== undefined) opts.apiKey = this.config.apiKey;
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
		return this.client.startThread(threadOpts);
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const thread = this.startThread(opts);
		const result = await thread.run(joinSystemPrompt(opts));
		const text = extractFinalText(result);
		return { text, kind: this.kind, raw: result };
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const result = await self.run(opts);
				yield { kind: self.kind, delta: result.text, raw: result.raw };
			},
		};
	}
}
