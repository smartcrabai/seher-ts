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

export type SpawnImpl = (
	bin: string,
	args: string[],
	options: { env?: Record<string, string> },
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
		await this.runTmux(
			"new-session",
			["new-session", "-d", "-s", id, "-c", options.cwd, ...options.command],
			options.env,
		);
		return { id };
	}

	async pasteText(session: TerminalSession, text: string): Promise<void> {
		await this.runTmux("send-keys", [
			"send-keys",
			"-t",
			session.id,
			"-l",
			text,
		]);
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
		await this.runTmux("kill-session", ["kill-session", "-t", session.id]);
	}

	private async runTmux(
		label: string,
		args: string[],
		env?: Record<string, string>,
	): Promise<SpawnResult> {
		const opts: { env?: Record<string, string> } = {};
		if (env !== undefined) opts.env = env;
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
		const proc = spawn(bin, args, {
			env: env as NodeJS.ProcessEnv,
			stdio: ["ignore", "pipe", "pipe"],
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
	});
