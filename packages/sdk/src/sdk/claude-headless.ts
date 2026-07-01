import { type ChildProcess, spawn } from "node:child_process";
import type {
	EffortLevel,
	PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { SdkKind } from "../types.ts";
import { isClaudeRateLimitMessage, LimitError } from "./errors.ts";
import { splitEffortSuffix } from "./model.ts";
import type {
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

export interface ClaudeHeadlessSDKConfig {
	/** Path to the `claude` CLI binary. Defaults to `"claude"` (resolved via $PATH). */
	claudeBin?: string;
	/** Model ID. `SeherRunOptions.model` takes precedence over this. */
	model?: string;
	/**
	 * Default reasoning effort passed to `claude --effort <level>`.
	 * A `:level` suffix on the model ID (e.g. `claude-opus-4-5:high`) takes
	 * precedence over this if present.
	 */
	effortLevel?: EffortLevel;
	/**
	 * Value passed to `--permission-mode <mode>`. `claude-headless` has no
	 * interactive UI, so the default is `"bypassPermissions"`.
	 */
	permissionMode?: PermissionMode;
	/** Working directory for the child process. */
	cwd?: string;
	/** Default run timeout (ms). Overridable via `SeherRunOptions.timeoutMs`. */
	timeoutMs?: number;
	/**
	 * Extra environment variables layered on top of `process.env`. Keys
	 * specified here take precedence over the `ANTHROPIC_API_KEY` /
	 * `ANTHROPIC_BASE_URL` derived from `apiKey` / `baseURL`.
	 */
	env?: Record<string, string>;
	/** Passed to the child process as `ANTHROPIC_API_KEY`. */
	apiKey?: string;
	/** Passed to the child process as `ANTHROPIC_BASE_URL`. */
	baseURL?: string;
	/** Target session ID for `claude --resume <id>` (optional). */
	resumeSessionId?: string;
}

/**
 * Input to `buildClaudeArgs`. Mirrors `ClaudeHeadlessRunner::build_args` on the Rust side.
 * Argument order is `[--resume <id>?] -p <prompt> [--model <m>] [--effort <level>?] [--append-system-prompt <s>] --permission-mode <mode>`.
 */
export interface BuildClaudeHeadlessArgsOptions {
	prompt: string;
	model?: string;
	systemPrompt?: string;
	permissionMode: PermissionMode;
	resume?: string;
	/** Reasoning effort fallback when `model` carries no recognized `:level` suffix. */
	effortLevel?: EffortLevel;
}

export function buildClaudeArgs(
	opts: BuildClaudeHeadlessArgsOptions,
): string[] {
	const args: string[] = [];
	if (opts.resume !== undefined) {
		args.push("--resume", opts.resume);
	}
	args.push("-p", opts.prompt);
	let suffixEffort: EffortLevel | undefined;
	if (opts.model !== undefined) {
		const { base, effort } = splitEffortSuffix(opts.model);
		args.push("--model", base);
		suffixEffort = effort;
	}
	const effectiveEffort = suffixEffort ?? opts.effortLevel;
	if (effectiveEffort !== undefined) {
		args.push("--effort", effectiveEffort);
	}
	if (opts.systemPrompt !== undefined) {
		args.push("--append-system-prompt", opts.systemPrompt);
	}
	args.push("--permission-mode", opts.permissionMode);
	return args;
}

export class ClaudeHeadlessTimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(timeoutMs: number) {
		super(`claude -p timed out after ${timeoutMs}ms`);
		this.name = "ClaudeHeadlessTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export class ClaudeHeadlessError extends Error {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stderr: string;
	constructor(
		exitCode: number | null,
		signal: NodeJS.Signals | null,
		stderr: string,
	) {
		const code = exitCode === null ? (signal ?? "signal") : exitCode.toString();
		super(`claude -p exited with ${code}: ${stderr}`);
		this.name = "ClaudeHeadlessError";
		this.exitCode = exitCode;
		this.signal = signal;
		this.stderr = stderr;
	}
}

interface RunResult {
	stdout: string;
}

/**
 * Lightweight SDK that spawns `claude -p` as a subprocess and returns the
 * entire stdout in one shot. Unlike `claude-terminal`, it does not do
 * tmux / transcript monitoring.
 */
export class ClaudeHeadlessSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "claude-headless";
	private readonly config: ClaudeHeadlessSDKConfig;

	constructor(config: ClaudeHeadlessSDKConfig = {}) {
		this.config = config;
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const { stdout } = await this.execute(opts);
		return { text: stdout, kind: this.kind, raw: { stdout } };
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const { stdout } = await self.execute(opts);
				if (stdout.length > 0) {
					yield { kind: self.kind, delta: stdout, raw: { stdout } };
				}
			},
		};
	}

	private buildEnv(): NodeJS.ProcessEnv {
		// Precedence: process.env (base) < config.env < apiKey/baseURL derived.
		// As with `ClaudeSDK`, explicitly specifying `apiKey`/`baseURL` overrides
		// `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` last.
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (this.config.env !== undefined) {
			for (const [k, v] of Object.entries(this.config.env)) {
				env[k] = v;
			}
		}
		if (this.config.apiKey !== undefined) {
			env.ANTHROPIC_API_KEY = this.config.apiKey;
		}
		if (this.config.baseURL !== undefined) {
			env.ANTHROPIC_BASE_URL = this.config.baseURL;
		}
		return env;
	}

	private async execute(opts: SeherRunOptions): Promise<RunResult> {
		const bin = this.config.claudeBin ?? "claude";
		const argsOpts: BuildClaudeHeadlessArgsOptions = {
			prompt: opts.prompt,
			permissionMode: this.config.permissionMode ?? DEFAULT_PERMISSION_MODE,
		};
		const model = opts.model ?? this.config.model;
		if (model !== undefined) argsOpts.model = model;
		if (this.config.effortLevel !== undefined) {
			argsOpts.effortLevel = this.config.effortLevel;
		}
		if (opts.systemPrompt !== undefined)
			argsOpts.systemPrompt = opts.systemPrompt;
		if (this.config.resumeSessionId !== undefined) {
			argsOpts.resume = this.config.resumeSessionId;
		}
		const args = buildClaudeArgs(argsOpts);

		const timeoutMs =
			opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

		const spawnOpts: Parameters<typeof spawn>[2] = {
			stdio: ["ignore", "pipe", "pipe"],
			env: this.buildEnv(),
		};
		if (this.config.cwd !== undefined) spawnOpts.cwd = this.config.cwd;

		let child: ChildProcess;
		try {
			child = spawn(bin, args, spawnOpts);
		} catch (err) {
			throw new Error(
				`failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`,
				{ cause: err },
			);
		}

		return await new Promise<RunResult>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;

			// Timeout timer. On firing, kill the child and reject.
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				try {
					child.kill("SIGKILL");
				} catch {
					// best-effort
				}
				reject(new ClaudeHeadlessTimeoutError(timeoutMs));
			}, timeoutMs);

			// Read stdout / stderr concurrently with independent listeners
			// (avoids a deadlock from a full pipe buffer).
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
			});

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(
					new Error(
						`failed to spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`,
						{ cause: err },
					),
				);
			});

			child.on("close", (code, signal) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (code === 0) {
					resolve({ stdout });
					return;
				}
				// A non-zero exit is checked against stderr content to detect a rate limit.
				if (isClaudeRateLimitMessage(stderr)) {
					reject(
						new LimitError("claude-headless", {
							provider: "claude-headless",
							message: stderr || `claude -p exited with ${code}`,
						}),
					);
					return;
				}
				reject(new ClaudeHeadlessError(code, signal, stderr));
			});
		});
	}
}
