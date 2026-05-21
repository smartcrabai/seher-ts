import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
	TerminalBackend,
	TerminalSession,
	TerminalStartOptions,
} from "./types.ts";
import { ClaudeTerminalError } from "./types.ts";

export interface TmuxBackendOptions {
	tmuxBin?: string;
	sessionPrefix?: string;
	spawnImpl?: SpawnImpl;
}

export interface SpawnOptions {
	env?: Record<string, string>;
	/** When provided, the spawn implementation writes this to the child's stdin. */
	stdin?: string;
}

export type SpawnImpl = (
	bin: string,
	args: string[],
	options: SpawnOptions,
) => Promise<SpawnResult>;

export interface SpawnResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

const DEFAULT_TMUX_BIN = "tmux";
const DEFAULT_SESSION_PREFIX = "seher-claude";

export class TmuxBackend implements TerminalBackend {
	private readonly tmuxBin: string;
	private readonly sessionPrefix: string;
	private readonly spawn: SpawnImpl;

	constructor(opts: TmuxBackendOptions = {}) {
		this.tmuxBin = opts.tmuxBin ?? DEFAULT_TMUX_BIN;
		this.sessionPrefix = opts.sessionPrefix ?? DEFAULT_SESSION_PREFIX;
		this.spawn = opts.spawnImpl ?? defaultSpawn;
	}

	async start(options: TerminalStartOptions): Promise<TerminalSession> {
		const id = `${this.sessionPrefix}-${randomUUID().slice(0, 8)}`;
		const spawnOpts: SpawnOptions = {};
		if (options.env !== undefined) spawnOpts.env = options.env;
		await this.runTmux(
			"new-session",
			["new-session", "-d", "-s", id, "-c", options.cwd, ...options.command],
			spawnOpts,
		);
		return { id };
	}

	/**
	 * Paste `text` into the Claude TUI atomically via a tmux paste buffer.
	 *
	 * `send-keys -l` sends each character as an individual keystroke, which
	 * Claude's TUI input loop can mis-buffer when followed immediately by an
	 * Enter — the trailing Enter ends up dropped and the prompt never gets
	 * submitted. Using `load-buffer` + `paste-buffer` performs a single
	 * bracketed-paste event from Claude's point of view, which it processes
	 * as a unit before the subsequent Enter (sent by `submit`) arrives.
	 */
	async pasteText(session: TerminalSession, text: string): Promise<void> {
		const bufferName = `${session.id}-prompt`;
		await this.runTmux("load-buffer", ["load-buffer", "-b", bufferName, "-"], {
			stdin: text,
		});
		let pasteError: unknown;
		try {
			await this.runTmux("paste-buffer", [
				"paste-buffer",
				"-b",
				bufferName,
				"-t",
				session.id,
			]);
		} catch (err) {
			pasteError = err;
		}
		try {
			await this.runTmux("delete-buffer", ["delete-buffer", "-b", bufferName]);
		} catch (deleteError) {
			if (pasteError === undefined) throw deleteError;
		}
		if (pasteError !== undefined) throw pasteError;
	}

	async submit(session: TerminalSession): Promise<void> {
		await this.runTmux("send-keys Enter", [
			"send-keys",
			"-t",
			session.id,
			"Enter",
		]);
	}

	async captureScreen(session: TerminalSession): Promise<string> {
		const result = await this.runTmux("capture-pane", [
			"capture-pane",
			"-p",
			"-t",
			session.id,
		]);
		return result.stdout;
	}

	async stop(session: TerminalSession): Promise<void> {
		// Best-effort cleanup of the paste buffer in case pasteText threw before
		// its own delete-buffer ran. tmux paste buffers are server-global and
		// outlive the killed session otherwise.
		try {
			await this.runTmux("delete-buffer", [
				"delete-buffer",
				"-b",
				`${session.id}-prompt`,
			]);
		} catch {
			// buffer may not exist; ignore
		}
		await this.runTmux("kill-session", ["kill-session", "-t", session.id]);
	}

	private async runTmux(
		label: string,
		args: string[],
		opts: SpawnOptions = {},
	): Promise<SpawnResult> {
		const result = await this.spawn(this.tmuxBin, args, opts);
		if (result.exitCode !== 0) {
			throw new ClaudeTerminalError(
				`tmux ${label} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
			);
		}
		return result;
	}
}

const defaultSpawn: SpawnImpl = (bin, args, options) =>
	new Promise((resolve, reject) => {
		const env =
			options.env !== undefined
				? { ...process.env, ...options.env }
				: process.env;
		const wantsStdin = options.stdin !== undefined;
		const proc = spawn(bin, args, {
			env: env as NodeJS.ProcessEnv,
			stdio: [wantsStdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		proc.stdout?.on("data", (c: Buffer) => stdoutChunks.push(c));
		proc.stderr?.on("data", (c: Buffer) => stderrChunks.push(c));
		proc.once("error", (err) => {
			reject(
				new ClaudeTerminalError(`failed to spawn ${bin}: ${err.message}`, {
					cause: err,
				}),
			);
		});
		proc.once("close", (code) => {
			resolve({
				exitCode: code,
				stdout: Buffer.concat(stdoutChunks).toString("utf8"),
				stderr: Buffer.concat(stderrChunks).toString("utf8"),
			});
		});
		if (wantsStdin && proc.stdin !== null) {
			proc.stdin.end(options.stdin);
		}
	});
