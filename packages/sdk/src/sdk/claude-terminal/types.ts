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
	pasteText(session: TerminalSession, text: string): Promise<void>;
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
}

export interface WaitForAssistantResponseOptions {
	timeoutMs: number;
	pollIntervalMs: number;
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

export interface ClaudeTranscriptReader {
	findSession(options: FindClaudeSessionOptions): Promise<ClaudeSessionRef>;
	waitForAssistantResponse(
		session: ClaudeSessionRef,
		options: WaitForAssistantResponseOptions,
	): Promise<ClaudeTerminalResponse>;
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
