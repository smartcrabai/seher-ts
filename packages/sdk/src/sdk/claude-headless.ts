import { type ChildProcess, spawn } from "node:child_process";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { SdkKind } from "../types.ts";
import { isClaudeRateLimitMessage, LimitError } from "./errors.ts";
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
	/** モデル ID。`SeherRunOptions.model` の方が優先される。 */
	model?: string;
	/**
	 * `--permission-mode <mode>` に渡す値。`claude-headless` は対話 UI を持たない
	 * ため、デフォルトは `"bypassPermissions"`。
	 */
	permissionMode?: PermissionMode;
	/** 子プロセスの作業ディレクトリ。 */
	cwd?: string;
	/** デフォルトの実行タイムアウト (ms)。`SeherRunOptions.timeoutMs` で上書き可。 */
	timeoutMs?: number;
	/**
	 * `process.env` に重ねて渡す追加環境変数。`apiKey` / `baseURL` から導出した
	 * `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` よりも、ここで指定したキーが優先される。
	 */
	env?: Record<string, string>;
	/** `ANTHROPIC_API_KEY` として子プロセスに渡す。 */
	apiKey?: string;
	/** `ANTHROPIC_BASE_URL` として子プロセスに渡す。 */
	baseURL?: string;
	/** `claude --resume <id>` の対象セッション ID (任意)。 */
	resumeSessionId?: string;
}

/**
 * `buildClaudeArgs` の入力。Rust 側 `ClaudeHeadlessRunner::build_args` と同等。
 * 引数順は `[--resume <id>?] -p <prompt> [--model <m>] [--append-system-prompt <s>] --permission-mode <mode>`。
 */
export interface BuildClaudeHeadlessArgsOptions {
	prompt: string;
	model?: string;
	systemPrompt?: string;
	permissionMode: PermissionMode;
	resume?: string;
}

export function buildClaudeArgs(
	opts: BuildClaudeHeadlessArgsOptions,
): string[] {
	const args: string[] = [];
	if (opts.resume !== undefined) {
		args.push("--resume", opts.resume);
	}
	args.push("-p", opts.prompt);
	if (opts.model !== undefined) {
		args.push("--model", opts.model);
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
 * `claude -p` をサブプロセスとして起動し、stdout 全体を 1 回で返す軽量 SDK。
 * `claude-terminal` のように tmux / トランスクリプト監視は行わない。
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
		// 優先順位: process.env (ベース) < config.env < apiKey/baseURL 由来。
		// `ClaudeSDK` と同様に、`apiKey`/`baseURL` を明示指定したら
		// `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` を最終的に上書きする。
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

			// タイムアウトのタイマー。発火時は kill して reject する。
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

			// stdout / stderr を独立した listener で並列読み (パイプ満杯による
			// デッドロックを避ける)。
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
				// 非ゼロ終了は stderr の内容から rate-limit を判定。
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
