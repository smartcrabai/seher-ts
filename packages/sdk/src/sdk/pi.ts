import {
	AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { rethrowAsLimit } from "./errors.ts";
import { extractTextBlocks, joinSystemPrompt } from "./text.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

const PI_LIMIT_PATTERN =
	/rate.?limit|usage.?limit|429|quota|too many requests/i;

function isPiLimit(err: unknown): boolean {
	return err instanceof Error && PI_LIMIT_PATTERN.test(err.message);
}

export interface PiSDKConfig {
	apiKey?: string;
	baseURL?: string;
	defaultModel?: string;
	defaultProviderID?: string;
	cwd?: string;
	agentDir?: string;
	thinkingLevel?: "low" | "medium" | "high";
}

const DEFAULT_PROVIDER_ID = "anthropic";

function parseModel(
	model: string,
	fallbackProvider: string,
): { providerID: string; modelID: string } {
	const slash = model.indexOf("/");
	if (slash > 0) {
		return {
			providerID: model.slice(0, slash),
			modelID: model.slice(slash + 1),
		};
	}
	return { providerID: fallbackProvider, modelID: model };
}

function extractAssistantText(
	messages: Array<{
		role: string;
		content: Array<{ type: string; text: string }>;
	}>,
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			return extractTextBlocks(msg.content);
		}
	}
	return "";
}

type SessionDisposable = { dispose(): Promise<unknown> };

type SubscribeEvent = {
	type: string;
	message?: unknown;
	assistantMessageEvent?: { type: string; delta?: string };
	messages?: unknown;
};

type SubscribeFn = {
	subscribe: (listener: (event: SubscribeEvent) => void) => () => void;
	prompt: (text: string) => Promise<unknown>;
	state: {
		readonly messages: Array<{
			role: string;
			content: Array<{ type: string; text: string }>;
		}>;
	};
} & SessionDisposable;

export class PiSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "pi";
	private readonly config: PiSDKConfig;
	private _session: SessionDisposable | null = null;
	private _sessionResult: CreateAgentSessionResult | null = null;
	private _sessionPending: Promise<CreateAgentSessionResult> | null = null;

	constructor(config: PiSDKConfig = {}) {
		this.config = config;
	}

	private buildModel(opts: SeherRunOptions): {
		providerID: string;
		modelID: string;
	} {
		const fallbackProvider =
			this.config.defaultProviderID ?? DEFAULT_PROVIDER_ID;
		if (opts.model !== undefined)
			return parseModel(opts.model, fallbackProvider);
		if (this.config.defaultModel !== undefined) {
			return parseModel(this.config.defaultModel, fallbackProvider);
		}
		throw new Error(
			"no model configured: provide runOpts.model or config.defaultModel",
		);
	}

	private async ensureSession(
		opts: SeherRunOptions,
	): Promise<CreateAgentSessionResult> {
		if (this._sessionResult !== null) return this._sessionResult;
		if (this._sessionPending !== null) return this._sessionPending;

		this._sessionPending = (async () => {
			const { providerID, modelID } = this.buildModel(opts);
			const authStorage = AuthStorage.inMemory();

			if (this.config.apiKey !== undefined) {
				authStorage.setRuntimeApiKey(providerID, this.config.apiKey);
			}

			const registry = ModelRegistry.inMemory(authStorage);

			if (this.config.baseURL !== undefined) {
				registry.registerProvider(providerID, {
					baseUrl: this.config.baseURL,
					apiKey: this.config.apiKey,
				});
			}

			const model = registry.find(providerID, modelID);
			if (model === undefined) {
				throw new Error(
					`pi: model not found for provider "${providerID}" / model "${modelID}"`,
				);
			}

			const sessionOpts: Record<string, unknown> = {
				model,
				authStorage,
				modelRegistry: registry,
			};
			if (this.config.cwd !== undefined) sessionOpts.cwd = this.config.cwd;
			if (this.config.agentDir !== undefined)
				sessionOpts.agentDir = this.config.agentDir;
			if (this.config.thinkingLevel !== undefined)
				sessionOpts.thinkingLevel = this.config.thinkingLevel;

			return createAgentSession(
				sessionOpts as Parameters<typeof createAgentSession>[0],
			);
		})();

		try {
			this._sessionResult = await this._sessionPending;
			return this._sessionResult;
		} finally {
			this._sessionPending = null;
		}
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const result = await this.ensureSession(opts);
		const session = result.session as unknown as SubscribeFn;
		this._session = session;
		const promptText = joinSystemPrompt(opts);

		const events: SubscribeEvent[] = [];
		const unsub = session.subscribe((event: SubscribeEvent) => {
			if (event.type === "agent_end") events.push(event);
		});

		let errored = false;
		try {
			await session.prompt(promptText);
		} catch (err) {
			errored = true;
			rethrowAsLimit("pi", err, isPiLimit);
		} finally {
			unsub();
			if (errored) {
				await session.dispose().catch(() => {});
				this._sessionResult = null;
				this._session = null;
			}
		}

		const stateMessages = session.state.messages;
		let text = extractAssistantText(stateMessages);

		if (text === "") {
			const agentEnd = events.find((e) => e.type === "agent_end");
			const eventMessages: Array<{
				role: string;
				content: Array<{ type: string; text: string }>;
			}> = ((agentEnd?.messages as Array<unknown>) ?? []) as Array<{
				role: string;
				content: Array<{ type: string; text: string }>;
			}>;
			text = extractAssistantText(eventMessages);
		}

		return { text, kind: this.kind, raw: session.state.messages };
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const result = await self.ensureSession(opts);
				const session = result.session as unknown as SubscribeFn;
				self._session = session;
				const promptText = joinSystemPrompt(opts);

				const chunks: Array<{ delta: string; raw: unknown }> = [];
				const unsub = session.subscribe((event: SubscribeEvent) => {
					if (event.type === "message_update") {
						const ame = event.assistantMessageEvent;
						if (ame?.type === "text_delta" && typeof ame.delta === "string") {
							chunks.push({ delta: ame.delta, raw: event });
						}
					}
				});

				let errored = false;
				try {
					await session.prompt(promptText);
				} catch (err) {
					errored = true;
					rethrowAsLimit("pi", err, isPiLimit);
				} finally {
					unsub();
					if (errored) {
						await session.dispose().catch(() => {});
						self._sessionResult = null;
						self._session = null;
					}
				}

				for (const chunk of chunks) {
					yield { kind: self.kind, delta: chunk.delta, raw: chunk.raw };
				}
			},
		};
	}

	async close(): Promise<void> {
		const pending = this._sessionPending;
		if (pending !== null) await pending.catch(() => {});
		const session = this._session;
		this._session = null;
		this._sessionResult = null;
		this._sessionPending = null;
		if (session !== null) {
			await session.dispose().catch(() => {});
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
