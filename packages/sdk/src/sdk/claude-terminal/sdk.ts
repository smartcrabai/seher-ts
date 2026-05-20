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
} from "./types.ts";
import { ClaudeTerminalError } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 500;

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
}

export class ClaudeTerminalSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "claude-terminal";
	private readonly config: ClaudeTerminalSDKConfig;
	private readonly backend: TerminalBackend;
	private readonly transcripts: ClaudeTranscriptReader;
	private readonly now: () => Date;

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

		const startedAt = this.now();
		const session = await this.backend.start({ cwd, command });
		try {
			await this.backend.pasteText(session, opts.prompt);
			const sessionRef = await this.transcripts.findSession({
				cwd,
				after: startedAt,
				timeoutMs,
				pollIntervalMs,
				root: transcriptRoot,
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
}
