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
	/**
	 * When unspecified, defers to the same auth resolution as pi itself
	 * (credentials from `pi login` saved in `<agentDir>/auth.json`, then
	 * environment variables like `ANTHROPIC_API_KEY`). When specified, it is
	 * used as a runtime override with the highest priority.
	 */
	apiKey?: string;
	/**
	 * When apiKey is not also specified, auth follows the normal apiKey
	 * resolution rules as-is (existing credentials from `<agentDir>/auth.json`
	 * or environment variables are used unchanged). If you don't want existing
	 * credentials sent to a different destination, specify apiKey explicitly too.
	 */
	baseURL?: string;
	defaultModel?: string;
	defaultProviderID?: string;
	cwd?: string;
	agentDir?: string;
	/**
	 * Thinking level passed to pi. When supplied via the `model:thinking`
	 * suffix (e.g. `anthropic/claude-opus-4-5:high`), it is stripped from the
	 * model ID inside the SDK and takes priority over this field.
	 */
	thinkingLevel?: ThinkingLevel;
	/** Default `run()` / `stream()` timeout in ms. Per-call: `SeherRunOptions.timeoutMs`. */
	timeoutMs?: number;
	/**
	 * When true (default), additionally inject `~/.claude/skills` and
	 * `<cwd>/.claude/skills` into the underlying Pi agent's resource loader.
	 * Pi does not auto-discover Claude-format skills natively, so this opts
	 * into the agentskills.io standard layout shared with Claude Code.
	 *
	 * `~/.agents/skills` is always injected regardless of this flag (matching
	 * the Rust seher reference implementation), so a user-wide skills directory
	 * shared with other agent runners works without any configuration.
	 */
	includeClaudeSkills?: boolean;
}

/**
 * Pure function that carves out the `additionalSkillPaths` assembly logic.
 * Kept separate for testability and to guarantee ordering (matching the
 * same order as the Rust reference implementation).
 *
 * - `~/.agents/skills` always comes first (matching the hardcoded behavior
 *   in Rust seher).
 * - `~/.claude/skills` and `<cwd>/.claude/skills` are only added when
 *   `includeClaudeSkills` is anything other than `false` (i.e. treated as
 *   defaulting to true).
 */
export function buildAdditionalSkillPaths(args: {
	homeDir: string;
	cwd: string;
	includeClaudeSkills?: boolean;
}): string[] {
	const paths: string[] = [join(args.homeDir, ".agents", "skills")];
	if (args.includeClaudeSkills !== false) {
		paths.push(join(args.homeDir, ".claude", "skills"));
		paths.push(join(args.cwd, ".claude", "skills"));
	}
	return paths;
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

type SessionDisposable = { dispose(): unknown };

/**
 * Calls `session.dispose()` on a best-effort basis. At runtime, `dispose()`
 * is invoked through `SubscribeFn` (`result.session as unknown as
 * SubscribeFn`), so there's no guarantee it returns a Promise (it may return
 * a non-Promise value or throw synchronously). Chaining `.catch()` directly
 * would itself throw when accessing a non-Promise return value, which would
 * overwrite the primary error (e.g. a failure from `session.prompt()`) in
 * the caller's `finally` block. So we swallow Promise rejections,
 * non-Promise return values, and synchronous throws alike.
 */
async function disposeSessionSilently(
	session: SessionDisposable,
): Promise<void> {
	try {
		await Promise.resolve(session.dispose());
	} catch {
		// best-effort cleanup; preserve the primary error path
	}
}

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
	// pi's session files are laid out as `<sessionDir>/<timestamp>_<id>.jsonl`.
	// When only the id is known, search via readdir for a file with a matching
	// suffix. Check both forms so this still works if pi's internal
	// implementation changes to just `<id>.jsonl`.
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
		// Strip the `:thinking` suffix first, then split into provider/model.
		// `anthropic/claude-opus-4-5:high` -> base=`anthropic/claude-opus-4-5`,
		// thinking=`high`. Variants like `openrouter/.../llama:free` remain in base.
		const { base, thinking } = splitThinkingSuffix(rawModel);
		const parsed = parseModel(base, fallbackProvider);
		return thinking !== undefined ? { ...parsed, thinking } : parsed;
	}

	private async ensureSession(
		opts: SeherRunOptions,
	): Promise<CreateAgentSessionResult> {
		// Validate the id at the SDK layer too when resume is specified (guards
		// against callers invoking SeherSDK directly without going through the CLI).
		if (opts.resume !== undefined) assertValidResumeId(opts.resume);

		// The session cache is only reused for the same resume id. If
		// `run({resume: "B"})` is called after `run({resume: "A"})`, dispose and
		// rebuild the session when the ids don't match, rather than silently
		// reusing the previous one.
		if (this._sessionResult !== null) {
			const cached = this._sessionId;
			const requested = opts.resume;
			if (requested === undefined || requested === cached) {
				return this._sessionResult;
			}
			// A different resume id was passed -> discard the cache and build a new session.
			const prev = this._session;
			this._session = null;
			this._sessionResult = null;
			this._sessionId = null;
			if (prev !== null) await disposeSessionSilently(prev);
		}
		if (this._sessionPending !== null) return this._sessionPending;

		this._sessionPending = (async () => {
			const { providerID, modelID, thinking } = this.buildModel(opts);
			const cwd = this.config.cwd ?? process.cwd();
			const agentDir = this.config.agentDir ?? getAgentDir();

			// Read the same files pi itself defaults to (`<agentDir>/auth.json` /
			// `<agentDir>/models.json`). This means credentials from `pi login`,
			// environment variables, and a user-defined models.json are used as-is
			// even without an apiKey (matching how the Rust seher reference defers
			// to pi_agent_rust's own default resolution). Only override at runtime
			// when apiKey is explicitly provided.
			const authStorage = AuthStorage.create(join(agentDir, "auth.json"));

			if (this.config.apiKey !== undefined) {
				authStorage.setRuntimeApiKey(providerID, this.config.apiKey);
			}

			const registry = ModelRegistry.create(
				authStorage,
				join(agentDir, "models.json"),
			);

			if (this.config.baseURL !== undefined) {
				registry.registerProvider(providerID, {
					baseUrl: this.config.baseURL,
					apiKey: this.config.apiKey,
				});
			}

			const model = registry.find(providerID, modelID);
			if (model === undefined) {
				// If models.json is malformed, ModelRegistry doesn't throw and instead
				// continues with only the built-in models. Since a missing `find()`
				// result alone doesn't reveal the cause, append the registry's load
				// error as the likely reason when one exists.
				const modelsJsonError = registry.getError();
				throw new Error(
					`pi: model not found for provider "${providerID}" / model "${modelID}"` +
						(modelsJsonError !== undefined
							? ` (models.json load error: ${modelsJsonError})`
							: ""),
				);
			}

			const sessionOpts: Record<string, unknown> = {
				model,
				authStorage,
				modelRegistry: registry,
				cwd,
				agentDir,
			};
			// A model ID suffix (e.g. `model:high`) takes priority over
			// config's thinkingLevel. If neither is specified, pi's default
			// (no extended thinking) is used.
			const effectiveThinking = thinking ?? this.config.thinkingLevel;
			if (effectiveThinking !== undefined)
				sessionOpts.thinkingLevel = effectiveThinking;

			// Always build the resource loader regardless of `includeClaudeSkills`
			// so that `~/.agents/skills` is always included (matching the hardcoded
			// behavior in Rust seher).
			const additionalSkillPaths = buildAdditionalSkillPaths({
				homeDir: homedir(),
				cwd,
				includeClaudeSkills: this.config.includeClaudeSkills,
			});
			const settingsManager = SettingsManager.create(cwd, agentDir);
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				additionalSkillPaths,
			});
			// `DefaultResourceLoader.reload()` silently skips skill paths that don't
			// exist (it just accumulates them in diagnostics internally), but swallow
			// any exception here just in case, so session creation itself never fails.
			try {
				await resourceLoader.reload();
			} catch (err) {
				console.info(
					"[seher-ts/pi] ignoring exception thrown by resourceLoader.reload():",
					err,
				);
			}
			sessionOpts.resourceLoader = resourceLoader;
			sessionOpts.settingsManager = settingsManager;

			// Build and pass in the SessionManager up front for both fresh and
			// resume cases. For fresh, a new id is assigned; for resume, the
			// existing file is loaded so `buildSessionContext()`'s messages are
			// non-empty, which makes pi auto-continue. The benefit of building it
			// up front is that we can obtain the id via
			// `sessionManager.getSessionId()` (which the CLI prints as
			// `session: <id>`). We pass `agentDir` explicitly so the session is
			// created under config's agentDir rather than `SessionManager.create`'s
			// implicit `~/.pi/agent/...`.
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
					await disposeSessionSilently(session);
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
						await disposeSessionSilently(session);
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
			await disposeSessionSilently(session);
		}
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
