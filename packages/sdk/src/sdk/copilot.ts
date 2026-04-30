import { approveAll, CopilotClient, defineTool } from "@github/copilot-sdk";
import type { z } from "zod";
import type { SeherTool } from "./tools.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

export interface CopilotSDKConfig {
	gitHubToken?: string;
	cliPath?: string;
	cliUrl?: string;
	defaultModel?: string;
	/**
	 * In-process tools registered via SeherSDK. Forwarded as `sessionConfig.tools`
	 * to the Copilot CLI.
	 */
	tools?: SeherTool<z.ZodObject<z.ZodRawShape>>[];
}

function toCopilotTool(t: SeherTool<z.ZodObject<z.ZodRawShape>>) {
	return defineTool(t.name, {
		description: t.description,
		// zod v4 ZodObject duck-types to copilot-sdk's ZodSchema (it exposes a
		// `toJSONSchema()` method). The structural match isn't visible to TS, so
		// we go through `unknown` and back.
		parameters: t.parameters as unknown as Record<string, unknown>,
		handler: async (args: unknown) => {
			return t.handler(args as never);
		},
	});
}

const DEFAULT_MODEL = "gpt-5";

type SessionLike = {
	send: (opts: { prompt: string }) => Promise<unknown>;
	sendAndWait: (opts: {
		prompt: string;
	}) => Promise<{ data?: { content?: string } } | undefined>;
	on: (
		eventType: string,
		handler: (event: {
			data?: { content?: string; deltaContent?: string };
		}) => void,
	) => () => void;
	disconnect: () => Promise<void>;
};

type ClientLike = {
	start: () => Promise<void>;
	createSession: (config: Record<string, unknown>) => Promise<SessionLike>;
};

export class CopilotSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "copilot";
	private readonly config: CopilotSDKConfig;
	private readonly tools: ReturnType<typeof toCopilotTool>[] | undefined;
	private _client: ClientLike | null = null;
	private _starting: Promise<ClientLike> | null = null;

	constructor(config: CopilotSDKConfig = {}) {
		this.config = config;
		this.tools =
			config.tools !== undefined && config.tools.length > 0
				? config.tools.map(toCopilotTool)
				: undefined;
	}

	private async getClient(): Promise<ClientLike> {
		if (this._client !== null) return this._client;
		if (this._starting !== null) return this._starting;
		this._starting = (async () => {
			const opts: Record<string, unknown> = {};
			if (this.config.gitHubToken !== undefined)
				opts.gitHubToken = this.config.gitHubToken;
			if (this.config.cliPath !== undefined) opts.cliPath = this.config.cliPath;
			if (this.config.cliUrl !== undefined) opts.cliUrl = this.config.cliUrl;
			const client = new CopilotClient(opts) as unknown as ClientLike;
			await client.start();
			this._client = client;
			return client;
		})();
		try {
			return await this._starting;
		} finally {
			this._starting = null;
		}
	}

	private async createSession(
		opts: SeherRunOptions,
		streaming: boolean,
	): Promise<SessionLike> {
		const client = await this.getClient();
		const sessionConfig: Record<string, unknown> = {
			model: opts.model ?? this.config.defaultModel ?? DEFAULT_MODEL,
			onPermissionRequest: approveAll,
			enableConfigDiscovery: true,
		};
		if (streaming) sessionConfig.streaming = true;
		if (opts.systemPrompt !== undefined) {
			sessionConfig.systemMessage = { append: opts.systemPrompt };
		}
		if (this.tools !== undefined) sessionConfig.tools = this.tools;
		return client.createSession(sessionConfig);
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const session = await this.createSession(opts, false);
		try {
			const event = await session.sendAndWait({ prompt: opts.prompt });
			const text = event?.data?.content ?? "";
			return { text, kind: this.kind, raw: event };
		} finally {
			await session.disconnect();
		}
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const session = await self.createSession(opts, true);
				const queue: SeherStreamChunk[] = [];
				let resolveNext: (() => void) | null = null;
				let done = false;

				const wake = () => {
					const fn = resolveNext;
					resolveNext = null;
					if (fn !== null) fn();
				};

				const push = (chunk: SeherStreamChunk) => {
					queue.push(chunk);
					wake();
				};

				const unsubDelta = session.on("assistant.message_delta", (event) => {
					const delta = event.data?.deltaContent ?? "";
					push({ kind: self.kind, delta, raw: event });
				});
				const unsubMessage = session.on("assistant.message", (event) => {
					push({ kind: self.kind, delta: "", raw: event });
				});

				const sendPromise = (async () => {
					try {
						await session.sendAndWait({ prompt: opts.prompt });
					} finally {
						done = true;
						wake();
					}
				})();

				try {
					while (true) {
						if (queue.length > 0) {
							const next = queue.shift();
							if (next !== undefined) yield next;
							continue;
						}
						if (done) break;
						await new Promise<void>((resolve) => {
							resolveNext = resolve;
						});
					}
					await sendPromise;
				} finally {
					unsubDelta();
					unsubMessage();
					await session.disconnect();
				}
			},
		};
	}
}
