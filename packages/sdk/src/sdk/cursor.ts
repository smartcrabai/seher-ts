import type { SDKAgent } from "@cursor/sdk";
import { Agent } from "@cursor/sdk";
import { extractTextBlocks, joinSystemPrompt } from "./text.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

export interface CursorSDKConfig {
	apiKey?: string;
	defaultModel?: string;
	/** Working directory for the local Cursor agent. Defaults to `process.cwd()`. */
	cwd?: string;
	/** When true, run as a cloud agent instead of local. */
	cloud?: boolean;
	/** Optional repos for cloud agents (e.g. `[{ url, startingRef }]`). */
	repos?: Array<{ url: string; startingRef?: string }>;
	/** Optional human-readable name surfaced in `Agent.list()`. */
	name?: string;
}

const DEFAULT_MODEL = "composer-2";

function extractAssistantText(event: unknown): string {
	const ev = event as { type?: string; message?: { content?: unknown } };
	if (ev?.type !== "assistant") return "";
	return extractTextBlocks(ev.message?.content);
}

export class CursorSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "cursor";
	private readonly config: CursorSDKConfig;

	constructor(config: CursorSDKConfig = {}) {
		this.config = config;
	}

	private buildAgentOptions(
		opts: SeherRunOptions,
	): Parameters<typeof Agent.create>[0] {
		const modelId = opts.model ?? this.config.defaultModel ?? DEFAULT_MODEL;
		const agentOpts: Parameters<typeof Agent.create>[0] = {
			model: { id: modelId },
		};
		if (this.config.apiKey !== undefined) agentOpts.apiKey = this.config.apiKey;
		if (this.config.name !== undefined) agentOpts.name = this.config.name;
		if (this.config.cloud) {
			agentOpts.cloud = {};
			if (this.config.repos !== undefined)
				agentOpts.cloud.repos = this.config.repos;
		} else {
			agentOpts.local = { cwd: this.config.cwd ?? process.cwd() };
		}
		return agentOpts;
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const agent: SDKAgent = await Agent.create(this.buildAgentOptions(opts));
		try {
			const run = await agent.send(joinSystemPrompt(opts));
			const result = await run.wait();
			return { text: result.result ?? "", kind: this.kind, raw: result };
		} finally {
			agent.close();
		}
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const agent: SDKAgent = await Agent.create(
					self.buildAgentOptions(opts),
				);
				try {
					const run = await agent.send(joinSystemPrompt(opts));
					for await (const event of run.stream()) {
						const delta = extractAssistantText(event);
						yield { kind: self.kind, delta, raw: event };
					}
				} finally {
					agent.close();
				}
			},
		};
	}
}
