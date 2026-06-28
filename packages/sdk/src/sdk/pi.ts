import { homedir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { rethrowAsLimit } from "./errors.ts";
import { splitThinkingSuffix, type ThinkingLevel } from "./model.ts";
import { extractTextBlocks, joinSystemPrompt } from "./text.ts";
import { withStreamTimeout, withTimeout } from "./timeout.ts";
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
	/**
	 * pi に渡す thinking レベル。`model:thinking` サフィックス (例:
	 * `anthropic/claude-opus-4-5:high`) で渡された場合は SDK 内部で
	 * モデル ID から strip され、こちらのフィールドより優先される。
	 */
	thinkingLevel?: ThinkingLevel;
	/** Default `run()` / `stream()` timeout in ms. Per-call: `SeherRunOptions.timeoutMs`. */
	timeoutMs?: number;
	/**
	 * When true (default), inject `~/.claude/skills` and `<cwd>/.claude/skills`
	 * into the underlying Pi agent's resource loader. Pi does not auto-discover
	 * Claude-format skills natively, so this opts into the agentskills.io
	 * standard layout shared with Claude Code.
	 */
	includeClaudeSkills?: boolean;
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
		thinking?: ThinkingLevel;
	} {
		const fallbackProvider =
			this.config.defaultProviderID ?? DEFAULT_PROVIDER_ID;
		const rawModel = opts.model ?? this.config.defaultModel;
		if (rawModel === undefined) {
			throw new Error(
				"no model configured: provide runOpts.model or config.defaultModel",
			);
		}
		// 先に `:thinking` サフィックスを切り出してから provider/model を分解
		// する。`anthropic/claude-opus-4-5:high` -> base=`anthropic/claude-opus-4-5`,
		// thinking=`high`。`openrouter/.../llama:free` のような変種は base に残る。
		const { base, thinking } = splitThinkingSuffix(rawModel);
		const parsed = parseModel(base, fallbackProvider);
		return thinking !== undefined ? { ...parsed, thinking } : parsed;
	}

	private async ensureSession(
		opts: SeherRunOptions,
	): Promise<CreateAgentSessionResult> {
		if (this._sessionResult !== null) return this._sessionResult;
		if (this._sessionPending !== null) return this._sessionPending;

		this._sessionPending = (async () => {
			const { providerID, modelID, thinking } = this.buildModel(opts);
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

			const cwd = this.config.cwd ?? process.cwd();
			const agentDir = this.config.agentDir ?? getAgentDir();
			const sessionOpts: Record<string, unknown> = {
				model,
				authStorage,
				modelRegistry: registry,
				cwd,
				agentDir,
			};
			// モデル ID のサフィックス (`model:high` 等) は config の
			// thinkingLevel より優先する。どちらも未指定なら pi のデフォルト
			// (extended thinking なし) を使う。
			const effectiveThinking = thinking ?? this.config.thinkingLevel;
			if (effectiveThinking !== undefined)
				sessionOpts.thinkingLevel = effectiveThinking;

			const includeClaudeSkills = this.config.includeClaudeSkills ?? true;
			if (includeClaudeSkills) {
				const settingsManager = SettingsManager.create(cwd, agentDir);
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager,
					additionalSkillPaths: [
						join(homedir(), ".claude", "skills"),
						join(cwd, ".claude", "skills"),
					],
				});
				await resourceLoader.reload();
				sessionOpts.resourceLoader = resourceLoader;
				sessionOpts.settingsManager = settingsManager;
			}

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
		const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
		const work = (async (): Promise<SeherRunResult> => {
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
		})();
		return withTimeout(work, timeoutMs, this.kind);
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		const timeoutMs = opts.timeoutMs ?? self.config.timeoutMs;
		const source: AsyncIterable<SeherStreamChunk> = {
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
		return withStreamTimeout(source, timeoutMs, self.kind);
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
