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
import {
	type EffortLevel,
	effortToThinking,
	splitThinkingSuffix,
	type ThinkingLevel,
} from "./model.ts";
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
	 * Thinking level passed to pi. Priority (highest first): `effortLevel`
	 * (mapped via `effortToThinking`), then a `model:thinking` suffix on the
	 * model ID (e.g. `anthropic/claude-opus-4-5:high`, stripped from the model
	 * ID inside the SDK), then this field as the final fallback.
	 */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Reasoning effort. Takes precedence over a `model:thinking` suffix on the
	 * model ID and over `thinkingLevel` -- mapped to pi's thinking level via
	 * `effortToThinking` (`max` rounds down to pi's highest tier, `xhigh`).
	 */
	effortLevel?: EffortLevel;
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
	/**
	 * Extra environment variables applied for the duration of `run()` /
	 * `stream()`. Since pi runs in-process (unlike the other subprocess-based
	 * backends), these are applied via direct `process.env` mutation --
	 * see `withPiEnvGuard` for the save/restore + cross-instance
	 * serialization that makes this safe.
	 */
	env?: Record<string, string>;
}

/** Matches an env key containing `=` or a NUL byte (see `withPiEnvGuard`). */
const INVALID_PI_ENV_KEY_PATTERN = /[=\0]/;

/**
 * Serializes every `process.env` mutation made on behalf of `env` across all
 * `PiSDK` instances in this process (pi runs in-process, so one run's env
 * mutation must never interleave with another concurrent run's).
 */
let piEnvLock: Promise<void> = Promise.resolve();

/**
 * When `env` is non-empty: validates its keys (throwing *before* touching
 * `process.env` or the serialization lock on a bad key), waits its turn on
 * the module-level `piEnvLock`, applies `env` on top of `process.env`, runs
 * `fn`, then restores every modified key to its prior value -- deleting keys
 * that were previously unset -- regardless of whether `fn` throws.
 *
 * When `env` is empty/undefined, runs `fn` directly with no locking or
 * mutation (mirrors the Rust `PiEnvGuard`, which is a no-op when there's
 * nothing to guard).
 */
async function withPiEnvGuard<T>(
	env: Record<string, string> | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	if (env === undefined || Object.keys(env).length === 0) {
		return fn();
	}
	for (const key of Object.keys(env)) {
		if (INVALID_PI_ENV_KEY_PATTERN.test(key)) {
			throw new Error(
				`pi: invalid env key '${key}' (must not contain '=' or NUL)`,
			);
		}
	}
	const previous = piEnvLock;
	let release: () => void = () => {};
	piEnvLock = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	const saved: Array<[string, string | undefined]> = Object.keys(env).map(
		(key) => [key, process.env[key]],
	);
	try {
		for (const [key, value] of Object.entries(env)) {
			process.env[key] = value;
		}
		return await fn();
	} finally {
		for (const [key, priorValue] of saved) {
			if (priorValue === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = priorValue;
			}
		}
		release();
	}
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

/**
 * Minimal shape of a pi session message that this adapter cares about.
 * `stopReason` / `errorMessage` mirror `AssistantMessage` from
 * `@earendil-works/pi-ai` -- present on assistant messages only, but kept
 * optional here since this type is also used for non-assistant messages.
 */
type PiMessage = {
	role: string;
	content: Array<{ type: string; text: string }>;
	stopReason?: string;
	errorMessage?: string;
};

function extractAssistantText(messages: PiMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant") {
			return extractTextBlocks(msg.content);
		}
	}
	return "";
}

/**
 * pi's provider errors (e.g. a 429 from the upstream API) don't throw from
 * `session.prompt()` -- pi records them as a normal assistant message with
 * `stopReason: "error"` and `errorMessage` set, and `prompt()` resolves as
 * usual. Left unchecked, this looks like a successful empty-text response
 * to callers, so the `rethrowAsLimit` / provider-failover machinery never
 * triggers (observed in production: a gqlrs loop kept using opencode-go
 * after it hit its weekly usage limit instead of failing over, producing a
 * flood of downstream "Agent used unexpected branch" failures).
 *
 * Throws a plain `Error` (message taken from `errorMessage` when present)
 * when the *last* assistant message in `messages` ended with
 * `stopReason === "error"`. Callers are expected to route the thrown error
 * back through `rethrowAsLimit` so limit-shaped messages become
 * `LimitError`. Only the last assistant message is inspected, so an earlier
 * mid-run error that was superseded by a later successful turn (e.g. an
 * internal retry) is still treated as success.
 */
function assertNoTrailingAssistantError(messages: PiMessage[]): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		if (msg.stopReason === "error") {
			throw new Error(
				msg.errorMessage ?? "pi: assistant turn ended with stopReason error",
			);
		}
		break;
	}
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
		readonly messages: PiMessage[];
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
		thinking?: ThinkingLevel | "max";
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
			// Priority (highest first): config.effortLevel (explicit /
			// config-resolved, mapped via effortToThinking), then a model ID
			// suffix (e.g. `model:high`), then config.thinkingLevel as the final
			// fallback. If none are specified, pi's default (no extended
			// thinking) is used. `thinking` may be the literal string `"max"`
			// (a valid EffortLevel with no ThinkingLevel equivalent) when the
			// model id carried a `:max` suffix and no effort took precedence --
			// left unmapped here so pi's own validation surfaces a clear error
			// rather than silently reinterpreting it.
			const effortThinking =
				this.config.effortLevel !== undefined
					? effortToThinking(this.config.effortLevel)
					: undefined;
			const effectiveThinking =
				effortThinking ?? thinking ?? this.config.thinkingLevel;
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
		const work = withPiEnvGuard(
			this.config.env,
			async (): Promise<SeherRunResult> => {
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
					// pi swallows provider errors (e.g. 429) instead of throwing --
					// they surface as a trailing assistant message with
					// `stopReason: "error"`. Detect that here so it flows through the
					// same `rethrowAsLimit` / dispose path as a thrown error below,
					// rather than being returned as an empty-text success.
					assertNoTrailingAssistantError(session.state.messages);
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
					const eventMessages: PiMessage[] = ((agentEnd?.messages as
						| Array<unknown>
						| undefined) ?? []) as PiMessage[];
					text = extractAssistantText(eventMessages);
				}

				const out: SeherRunResult = {
					text,
					kind: this.kind,
					raw: session.state.messages,
				};
				if (this._sessionId !== null) out.sessionId = this._sessionId;
				return out;
			},
		);
		return withTimeout(work, timeoutMs, this.kind);
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		const timeoutMs = opts.timeoutMs ?? self.config.timeoutMs;
		const source: AsyncIterable<SeherStreamChunk> = {
			async *[Symbol.asyncIterator]() {
				// The env guard only needs to cover the actual pi interaction
				// (session setup through prompt()); the collected chunks are
				// replayed below, outside the guarded region.
				const chunks = await withPiEnvGuard(
					self.config.env,
					async (): Promise<Array<{ delta: string; raw: unknown }>> => {
						const result = await self.ensureSession(opts);
						const session = result.session as unknown as SubscribeFn;
						self._session = session;
						const promptText = joinSystemPrompt(opts);

						const collected: Array<{ delta: string; raw: unknown }> = [];
						const unsub = session.subscribe((event: SubscribeEvent) => {
							if (event.type === "message_update") {
								const ame = event.assistantMessageEvent;
								if (
									ame?.type === "text_delta" &&
									typeof ame.delta === "string"
								) {
									collected.push({ delta: ame.delta, raw: event });
								}
							}
						});

						let errored = false;
						try {
							await session.prompt(promptText);
							// Same trailing-error detection as run(): pi records provider
							// errors as a normal assistant message instead of throwing, so
							// check once the underlying prompt iteration has fully settled
							// (and before any chunk is yielded downstream).
							assertNoTrailingAssistantError(session.state.messages);
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

						return collected;
					},
				);

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
