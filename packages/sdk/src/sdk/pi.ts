import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AuthStorage,
	type CreateAgentSessionResult,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { assertValidResumeId, rethrowAsLimit } from "./errors.ts";
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
	thinkingLevel?: "low" | "medium" | "high";
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

/**
 * Compute pi's per-cwd session directory.
 * Mirrors `getDefaultSessionDirPath` in `@earendil-works/pi-coding-agent`:
 *   `<agentDir>/sessions/--<cwd_with_separators_to_dashes>--/`
 *
 * Keep this in sync with the upstream encoder. We could discover the path via
 * `SessionManager.create(...)` and read `getSessionDir()`, but that creates
 * the directory eagerly, which we want to avoid in the `--resume` path before
 * we know whether the id is valid.
 */
function piSessionDir(cwd: string, agentDir: string): string {
	const safeCwd = cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	return join(agentDir, "sessions", `--${safeCwd}--`);
}

/**
 * Locate pi's on-disk session file for `id` under `cwd` and open it.
 * Throws when no matching session is found -- mirrors the Rust `resume_and_stream`
 * "session not found under cwd" behavior so the caller surfaces a clean error.
 */
function openPiSessionById(
	cwd: string,
	agentDir: string,
	id: string,
): SessionManager {
	// pi のセッションファイルは `<sessionDir>/<timestamp>_<id>.jsonl` で配置される。
	// id だけ知っている場合は readdir でサフィックス一致のファイルを探す。
	// pi の内部実装が変わって `<id>.jsonl` だけになっていても拾えるよう、両形式を見る。
	const sessionDir = piSessionDir(cwd, agentDir);
	let entries: string[] = [];
	try {
		entries = readdirSync(sessionDir);
	} catch (e) {
		throw new Error(
			`pi: session directory not found for cwd '${cwd}' (looked under '${sessionDir}'): ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
	const suffix = `_${id}.jsonl`;
	const exact = `${id}.jsonl`;
	const match = entries.find((e) => e === exact || e.endsWith(suffix));
	if (match === undefined) {
		throw new Error(
			`pi: session '${id}' not found under cwd '${cwd}' (resume requires the same --cwd used to create it)`,
		);
	}
	return SessionManager.open(join(sessionDir, match));
}

export class PiSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "pi";
	private readonly config: PiSDKConfig;
	private _session: SessionDisposable | null = null;
	private _sessionResult: CreateAgentSessionResult | null = null;
	private _sessionPending: Promise<CreateAgentSessionResult> | null = null;
	/**
	 * id of the currently-bound session. Populated by `ensureSession` so that
	 * `run()` / `lastSessionId()` can surface it as the printable session id.
	 * Reset to `null` when the session is disposed.
	 */
	private _sessionId: string | null = null;

	lastSessionId(): string | undefined {
		return this._sessionId ?? undefined;
	}

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
		// resume 指定時は SDK 層でも id を validate する (CLI を介さず SeherSDK を
		// 直接呼ぶケースの防御)。
		if (opts.resume !== undefined) assertValidResumeId(opts.resume);

		// セッションキャッシュは同じ resume id に対してのみ再利用する。
		// `run({resume: "A"})` の後で `run({resume: "B"})` を呼んだ際に前のセッションを
		// silent に使い回さないよう、id が一致しない場合は dispose して作り直す。
		if (this._sessionResult !== null) {
			const cached = this._sessionId;
			const requested = opts.resume;
			if (requested === undefined || requested === cached) {
				return this._sessionResult;
			}
			// 別の resume id が渡された -> キャッシュを破棄して新しい session を作る。
			const prev = this._session;
			this._session = null;
			this._sessionResult = null;
			this._sessionId = null;
			if (prev !== null) await prev.dispose().catch(() => {});
		}
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

			const cwd = this.config.cwd ?? process.cwd();
			const agentDir = this.config.agentDir ?? getAgentDir();
			const sessionOpts: Record<string, unknown> = {
				model,
				authStorage,
				modelRegistry: registry,
				cwd,
				agentDir,
			};
			if (this.config.thinkingLevel !== undefined)
				sessionOpts.thinkingLevel = this.config.thinkingLevel;

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

			// fresh / resume いずれも事前に SessionManager を構築して渡す。
			// fresh の場合は新規 id が採番され、resume の場合は既存ファイルをロードして
			// `buildSessionContext()` の messages 非空 → pi が自動継続する。
			// 事前構築する利点は、`sessionManager.getSessionId()` で id をこちらが
			// 把握できる点 (これを CLI が `session: <id>` として出力する)。
			// `agentDir` を渡しているので、`SessionManager.create` の暗黙の
			// `~/.pi/agent/...` ではなく config の agentDir 配下に session を作る。
			const sessionManager =
				opts.resume !== undefined
					? openPiSessionById(cwd, agentDir, opts.resume)
					: SessionManager.create(cwd, piSessionDir(cwd, agentDir));
			sessionOpts.sessionManager = sessionManager;
			this._sessionId = sessionManager.getSessionId();

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
					this._sessionId = null;
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

			const out: SeherRunResult = {
				text,
				kind: this.kind,
				raw: session.state.messages,
			};
			if (this._sessionId !== null) out.sessionId = this._sessionId;
			return out;
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
						self._sessionId = null;
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
		this._sessionId = null;
		if (session !== null) {
			await session.dispose().catch(() => {});
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
