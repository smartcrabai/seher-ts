import Anthropic from "@anthropic-ai/sdk";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

export interface ClaudeSDKConfig {
	apiKey?: string;
	baseURL?: string;
	defaultModel?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 1024;

type ContentBlockLike = { type?: string; text?: string };

function extractText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content as ContentBlockLike[]) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("");
}

export class ClaudeSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "claude";
	private readonly config: ClaudeSDKConfig;
	private _client: Anthropic | null = null;

	constructor(config: ClaudeSDKConfig = {}) {
		this.config = config;
	}

	private get client(): Anthropic {
		if (this._client === null) {
			const opts: { apiKey?: string; baseURL?: string } = {};
			if (this.config.apiKey !== undefined) opts.apiKey = this.config.apiKey;
			if (this.config.baseURL !== undefined) opts.baseURL = this.config.baseURL;
			this._client = new Anthropic(opts);
		}
		return this._client;
	}

	private buildParams(opts: SeherRunOptions) {
		const params: {
			model: string;
			max_tokens: number;
			messages: Array<{ role: "user"; content: string }>;
			system?: string;
		} = {
			model: opts.model ?? this.config.defaultModel ?? DEFAULT_MODEL,
			max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
			messages: [{ role: "user", content: opts.prompt }],
		};
		if (opts.systemPrompt !== undefined) {
			params.system = opts.systemPrompt;
		}
		return params;
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const params = this.buildParams(opts);
		const response = await this.client.messages.create(params);
		const text = extractText((response as { content?: unknown }).content);
		return { text, kind: this.kind, raw: response };
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const params = this.buildParams(opts);
		const client = this.client;
		const kind = this.kind;
		return {
			async *[Symbol.asyncIterator]() {
				const s = client.messages.stream(params);
				for await (const event of s as AsyncIterable<unknown>) {
					const ev = event as {
						type?: string;
						delta?: { type?: string; text?: string };
					};
					let delta = "";
					if (
						ev.type === "content_block_delta" &&
						ev.delta &&
						ev.delta.type === "text_delta" &&
						typeof ev.delta.text === "string"
					) {
						delta = ev.delta.text;
					}
					yield { kind, delta, raw: event };
				}
			},
		};
	}
}
