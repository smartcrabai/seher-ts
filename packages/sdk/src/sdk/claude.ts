import {
	type Options,
	type PermissionMode,
	query,
} from "@anthropic-ai/claude-agent-sdk";
import { extractTextBlocks } from "./text.ts";
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
	/** Permission mode for the Claude agent. `"auto"` uses a model classifier. */
	permissionMode?: PermissionMode;
	cwd?: string;
}

const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";

export class ClaudeSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "claude";
	private readonly config: ClaudeSDKConfig;

	constructor(config: ClaudeSDKConfig = {}) {
		this.config = config;
	}

	private buildOptions(opts: SeherRunOptions): Options {
		const permissionMode =
			this.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
		const options: Options = { permissionMode };
		if (permissionMode === "bypassPermissions") {
			options.allowDangerouslySkipPermissions = true;
		}
		const model = opts.model ?? this.config.defaultModel;
		if (model !== undefined) options.model = model;
		if (opts.systemPrompt !== undefined) {
			options.systemPrompt = opts.systemPrompt;
		}
		if (this.config.cwd !== undefined) options.cwd = this.config.cwd;

		const env: Record<string, string> = {};
		if (this.config.apiKey !== undefined) {
			env.ANTHROPIC_API_KEY = this.config.apiKey;
		}
		if (this.config.baseURL !== undefined) {
			env.ANTHROPIC_BASE_URL = this.config.baseURL;
		}
		if (Object.keys(env).length > 0) options.env = env;

		return options;
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const q = query({ prompt: opts.prompt, options: this.buildOptions(opts) });
		let text = "";
		let raw: unknown;
		for await (const message of q) {
			if (message.type === "result") {
				raw = message;
				if (message.subtype === "success") text = message.result;
				break;
			}
		}
		return { text, kind: this.kind, raw };
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const q = query({
					prompt: opts.prompt,
					options: self.buildOptions(opts),
				});
				for await (const message of q) {
					if (message.type !== "assistant") continue;
					const delta = extractTextBlocks(message.message.content);
					if (delta.length === 0) continue;
					yield { kind: self.kind, delta, raw: message };
				}
			},
		};
	}
}
