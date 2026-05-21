import type { SdkKind } from "../../types.ts";
import type {
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "../types.ts";
import {
	type BuildClaudeCommandOptions,
	buildClaudeCommand,
} from "./command.ts";
import { normalizeText } from "./response-normalizer.ts";
import { TmuxBackend } from "./tmux-backend.ts";
import {
	defaultTranscriptRoot,
	FileSystemTranscriptReader,
} from "./transcript-reader.ts";
import type {
	ClaudeTerminalResponse,
	ClaudeTranscriptReader,
	TerminalBackend,
	TerminalSession,
} from "./types.ts";
import { ClaudeTerminalError, ClaudeTerminalTimeoutError } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 30 * 1000;
const DEFAULT_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_READY_INDICATOR = "❯";

export interface ClaudeTerminalSDKConfig {
	cwd?: string;
	backend?: "tmux";
	timeoutMs?: number;
	keepSession?: boolean;
	transcriptPollIntervalMs?: number;
	claudeBin?: string;
	tmuxBin?: string;
	transcriptRoot?: string;
	dangerouslySkipPermissions?: boolean;
	backendImpl?: TerminalBackend;
	transcriptReader?: ClaudeTranscriptReader;
	now?: () => Date;
	/**
	 * How long to wait for the Claude TUI input prompt to render after launch,
	 * before pasting the user's prompt. Throws a timeout error if the indicator
	 * never appears within this window.
	 */
	readyTimeoutMs?: number;
	/** Poll interval (ms) when waiting for the TUI to become ready. */
	readyPollIntervalMs?: number;
	/**
	 * Substring expected in the tmux screen capture once Claude's TUI is ready
	 * to accept input. Defaults to "❯" (Claude Code's input prompt arrow).
	 */
	readyIndicator?: string;
	/** Override the sleep implementation (used in tests). */
	sleep?: (ms: number) => Promise<void>;
}

export class ClaudeTerminalSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "claude-terminal";
	private readonly config: ClaudeTerminalSDKConfig;
	private readonly backend: TerminalBackend;
	private readonly transcripts: ClaudeTranscriptReader;
	private readonly now: () => Date;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(config: ClaudeTerminalSDKConfig = {}) {
		this.config = config;
		if (config.backend !== undefined && config.backend !== "tmux") {
			throw new ClaudeTerminalError(
				`unsupported backend "${config.backend}" — only "tmux" is implemented`,
			);
		}
		if (config.backendImpl !== undefined) {
			this.backend = config.backendImpl;
		} else {
			const tmuxOpts: ConstructorParameters<typeof TmuxBackend>[0] = {};
			if (config.tmuxBin !== undefined) tmuxOpts.tmuxBin = config.tmuxBin;
			this.backend = new TmuxBackend(tmuxOpts);
		}
		this.transcripts =
			config.transcriptReader ?? new FileSystemTranscriptReader();
		this.now = config.now ?? (() => new Date());
		this.sleep =
			config.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const response = await this.execute(opts);
		const text = normalizeText(response);
		return { text, kind: this.kind, raw: response };
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const response = await self.execute(opts);
				const delta = normalizeText(response);
				if (delta.length > 0) {
					yield { kind: self.kind, delta, raw: response };
				}
			},
		};
	}

	private async execute(
		opts: SeherRunOptions,
	): Promise<ClaudeTerminalResponse> {
		const cwd = this.config.cwd ?? process.cwd();
		const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const pollIntervalMs =
			this.config.transcriptPollIntervalMs ??
			DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS;
		const transcriptRoot =
			this.config.transcriptRoot ?? defaultTranscriptRoot();
		const readyTimeoutMs =
			this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const readyPollIntervalMs =
			this.config.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
		const readyIndicator =
			this.config.readyIndicator ?? DEFAULT_READY_INDICATOR;

		const cmdOpts: BuildClaudeCommandOptions = {
			claudeBin: this.config.claudeBin ?? "claude",
		};
		if (opts.model !== undefined) cmdOpts.model = opts.model;
		if (opts.systemPrompt !== undefined)
			cmdOpts.systemPrompt = opts.systemPrompt;
		if (this.config.dangerouslySkipPermissions !== undefined) {
			cmdOpts.dangerouslySkipPermissions =
				this.config.dangerouslySkipPermissions;
		}
		const command = buildClaudeCommand(cmdOpts);

		const excludeNames = await this.transcripts.listSessionNames({
			root: transcriptRoot,
			cwd,
		});
		const startedAt = this.now();
		const session = await this.backend.start({ cwd, command });
		try {
			await this.waitForReady(session, {
				indicator: readyIndicator,
				timeoutMs: readyTimeoutMs,
				pollIntervalMs: readyPollIntervalMs,
			});
			await this.backend.pasteText(session, opts.prompt);
			await this.waitForPasteVisible(session, opts.prompt, {
				timeoutMs: readyTimeoutMs,
				pollIntervalMs: readyPollIntervalMs,
			});
			await this.backend.submit(session);
			const sessionRef = await this.transcripts.findSession({
				cwd,
				after: startedAt,
				timeoutMs,
				pollIntervalMs,
				root: transcriptRoot,
				excludeNames,
			});
			return await this.transcripts.waitForAssistantResponse(sessionRef, {
				timeoutMs,
				pollIntervalMs,
			});
		} finally {
			if (!this.config.keepSession) {
				try {
					await this.backend.stop(session);
				} catch {
					// best-effort cleanup; do not mask the original error
				}
			}
		}
	}

	private async waitForPasteVisible(
		session: TerminalSession,
		prompt: string,
		opts: { timeoutMs: number; pollIntervalMs: number },
	): Promise<void> {
		// Look for a suffix of the prompt that is unlikely to wrap across
		// terminal lines. Without this, we might submit Enter before Claude's
		// TUI finished consuming the pasted text — Claude buffers fast input
		// and a too-early Enter is dropped.
		const needle = pasteNeedle(prompt);
		const deadline = this.now().getTime() + opts.timeoutMs;
		while (true) {
			let screen = "";
			try {
				screen = await this.backend.captureScreen(session);
			} catch {
				screen = "";
			}
			if (screen.includes(needle)) {
				return;
			}
			if (this.now().getTime() >= deadline) {
				throw new ClaudeTerminalTimeoutError(
					`timed out waiting for pasted prompt to appear in Claude TUI (looking for "${needle}" within ${opts.timeoutMs}ms)`,
				);
			}
			await this.sleep(opts.pollIntervalMs);
		}
	}

	private async waitForReady(
		session: TerminalSession,
		opts: { indicator: string; timeoutMs: number; pollIntervalMs: number },
	): Promise<void> {
		const MAX_CONSECUTIVE_CAPTURE_FAILURES = 3;
		const deadline = this.now().getTime() + opts.timeoutMs;
		let consecutiveFailures = 0;
		while (true) {
			let screen = "";
			try {
				screen = await this.backend.captureScreen(session);
				consecutiveFailures = 0;
			} catch (err) {
				consecutiveFailures += 1;
				if (consecutiveFailures >= MAX_CONSECUTIVE_CAPTURE_FAILURES) {
					throw new ClaudeTerminalError(
						`captureScreen failed ${consecutiveFailures} times in a row while waiting for Claude TUI to render`,
						{ cause: err },
					);
				}
			}
			if (screen.includes(opts.indicator)) {
				return;
			}
			if (this.now().getTime() >= deadline) {
				throw new ClaudeTerminalTimeoutError(
					`timed out waiting for Claude TUI to render (no "${opts.indicator}" within ${opts.timeoutMs}ms)`,
				);
			}
			await this.sleep(opts.pollIntervalMs);
		}
	}
}

function pasteNeedle(prompt: string): string {
	const trimmed = prompt.trimEnd();
	const lastLine = trimmed.split("\n").at(-1) ?? trimmed;
	return lastLine.length > 24 ? lastLine.slice(-24) : lastLine;
}
