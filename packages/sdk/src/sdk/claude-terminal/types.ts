export interface TerminalStartOptions {
	cwd: string;
	command: string[];
	env?: Record<string, string>;
}

export interface TerminalSession {
	readonly id: string;
}

export interface TerminalBackend {
	start(options: TerminalStartOptions): Promise<TerminalSession>;
	/**
	 * Send `text` to the terminal as if pasted. Must not send a terminating
	 * Enter / submit keystroke — callers verify the text rendered before
	 * submitting separately via `submit()`.
	 */
	pasteText(session: TerminalSession, text: string): Promise<void>;
	/** Send a single Enter keystroke to submit the current input. */
	submit(session: TerminalSession): Promise<void>;
	captureScreen(session: TerminalSession): Promise<string>;
	stop(session: TerminalSession): Promise<void>;
}

export interface ClaudeSessionRef {
	readonly sessionId: string;
	readonly transcriptPath: string;
}

export interface FindClaudeSessionOptions {
	cwd: string;
	after: Date;
	timeoutMs: number;
	pollIntervalMs: number;
	root: string;
	/**
	 * Basenames (e.g. "abc.jsonl") of transcripts that existed before the new
	 * Claude session was launched. Used to skip transcripts belonging to other
	 * Claude sessions running concurrently in the same project directory.
	 */
	excludeNames?: ReadonlySet<string>;
}

export interface ClaudeTranscriptReader {
	findSession(options: FindClaudeSessionOptions): Promise<ClaudeSessionRef>;
	waitForAssistantResponse(
		session: ClaudeSessionRef,
		options: WaitForAssistantResponseOptions,
	): Promise<ClaudeTerminalResponse>;
	/**
	 * Snapshot the set of transcript jsonl basenames currently present in
	 * `<root>/<encodedProjectDir(cwd)>`. Returns an empty set if the directory
	 * does not exist yet.
	 */
	listSessionNames(opts: { root: string; cwd: string }): Promise<Set<string>>;
	/**
	 * Count assistant messages currently present in `transcriptPath`. Used to
	 * establish a baseline before a resumed turn is submitted, so
	 * `waitForAssistantResponse` only returns once the count grows. Returns `0`
	 * if the file does not exist or is empty.
	 */
	countAssistantMessages?(transcriptPath: string): Promise<number>;
}

export interface WaitForAssistantResponseOptions {
	timeoutMs: number;
	pollIntervalMs: number;
	/**
	 * Minimum number of assistant messages that must exist in the transcript
	 * before the poll loop considers the turn complete. Used by `--resume`,
	 * where the file already contains the prior turn's messages: the new turn
	 * must produce **more** than the baseline before we return. Default: `0`
	 * (any assistant message satisfies, matching the fresh-turn semantics).
	 */
	minAssistantCount?: number;
}

export interface TranscriptMessage {
	type: "assistant" | "user" | "result" | "system";
	uuid?: string;
	sessionId?: string;
	subtype?: string;
	result?: string;
	is_error?: boolean;
	message?: { content?: unknown; role?: string };
	[key: string]: unknown;
}

export interface ClaudeTerminalResponse {
	sessionId: string;
	assistantMessages: TranscriptMessage[];
	lastResultMessage?: TranscriptMessage;
}

export class ClaudeTerminalError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ClaudeTerminalError";
	}
}

export class ClaudeTerminalTimeoutError extends ClaudeTerminalError {
	constructor(message: string) {
		super(message);
		this.name = "ClaudeTerminalTimeoutError";
	}
}

/**
 * Raised when the Claude TUI displays a "session limit reached" banner instead
 * of the input prompt. Distinct from a generic timeout so callers can recognize
 * the condition as retriable-after-reset rather than a transport failure.
 *
 * `resetInfo` carries the human-readable reset time as displayed by the TUI
 * (e.g. `"6:40pm (Asia/Tokyo)"`) when extractable. It is intentionally a free
 * string — the TUI formats / timezone are not part of seher-ts's contract.
 */
export class ClaudeTerminalSessionLimitError extends ClaudeTerminalError {
	readonly resetInfo: string | undefined;
	constructor(resetInfo: string | undefined) {
		super(
			resetInfo !== undefined
				? `Claude session limit reached (resets ${resetInfo})`
				: "Claude session limit reached",
		);
		this.name = "ClaudeTerminalSessionLimitError";
		this.resetInfo = resetInfo;
	}
}
