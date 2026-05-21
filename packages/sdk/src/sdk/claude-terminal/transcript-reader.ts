import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	ClaudeSessionRef,
	ClaudeTerminalResponse,
	ClaudeTranscriptReader,
	FindClaudeSessionOptions,
	TranscriptMessage,
	WaitForAssistantResponseOptions,
} from "./types.ts";
import { ClaudeTerminalTimeoutError } from "./types.ts";

/**
 * Claude Code rewrites `/Users/foo/repo` to `-Users-foo-repo` for the
 * project directory under `~/.claude/projects/`.
 */
export function encodeProjectDir(cwd: string): string {
	return resolve(cwd).replace(/[\\/]/g, "-");
}

export function defaultTranscriptRoot(): string {
	return join(homedir(), ".claude", "projects");
}

export interface FsAdapter {
	readdir: (path: string) => Promise<string[]>;
	stat: (path: string) => Promise<{ mtimeMs: number }>;
	readFile: (path: string) => Promise<string>;
}

const defaultFs: FsAdapter = {
	readdir: (p) => readdir(p),
	stat: async (p) => {
		const s = await stat(p);
		return { mtimeMs: s.mtimeMs };
	},
	readFile: (p) => readFile(p, "utf8"),
};

export interface FileSystemTranscriptReaderOptions {
	fs?: FsAdapter;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export class FileSystemTranscriptReader implements ClaudeTranscriptReader {
	private readonly fs: FsAdapter;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(opts: FileSystemTranscriptReaderOptions = {}) {
		this.fs = opts.fs ?? defaultFs;
		this.now = opts.now ?? (() => Date.now());
		this.sleep =
			opts.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
	}

	async findSession(
		options: FindClaudeSessionOptions,
	): Promise<ClaudeSessionRef> {
		const dir = join(options.root, encodeProjectDir(options.cwd));
		const deadline = this.now() + options.timeoutMs;
		const afterMs = options.after.getTime();
		const exclude = options.excludeNames;
		while (true) {
			let entries: string[] = [];
			try {
				entries = await this.fs.readdir(dir);
			} catch {
				entries = [];
			}
			const jsonl = entries.filter(
				(e) => e.endsWith(".jsonl") && exclude?.has(e) !== true,
			);
			const stats = await Promise.all(
				jsonl.map(async (name) => {
					const path = join(dir, name);
					try {
						const s = await this.fs.stat(path);
						return { path, mtimeMs: s.mtimeMs };
					} catch {
						return null;
					}
				}),
			);
			const candidates = stats.filter(
				(s): s is { path: string; mtimeMs: number } =>
					s !== null && s.mtimeMs >= afterMs,
			);
			candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
			const first = candidates[0];
			if (first !== undefined) {
				return {
					sessionId: basename(first.path, ".jsonl"),
					transcriptPath: first.path,
				};
			}
			if (this.now() >= deadline) {
				throw new ClaudeTerminalTimeoutError(
					`timed out finding Claude transcript under ${dir} (after ${options.after.toISOString()})`,
				);
			}
			await this.sleep(options.pollIntervalMs);
		}
	}

	async listSessionNames(opts: {
		root: string;
		cwd: string;
	}): Promise<Set<string>> {
		const dir = join(opts.root, encodeProjectDir(opts.cwd));
		let entries: string[] = [];
		try {
			entries = await this.fs.readdir(dir);
		} catch {
			entries = [];
		}
		return new Set(entries.filter((e) => e.endsWith(".jsonl")));
	}

	async waitForAssistantResponse(
		session: ClaudeSessionRef,
		options: WaitForAssistantResponseOptions,
	): Promise<ClaudeTerminalResponse> {
		const deadline = this.now() + options.timeoutMs;
		while (true) {
			let raw = "";
			try {
				raw = await this.fs.readFile(session.transcriptPath);
			} catch {
				raw = "";
			}
			const { assistantMessages, lastResult, turnComplete } = scanTranscript(
				parseJsonl(raw),
			);
			if (lastResult !== undefined) {
				return {
					sessionId: session.sessionId,
					assistantMessages,
					lastResultMessage: lastResult,
				};
			}
			// Interactive TUI never emits a "result" message; instead it logs
			// `system/turn_duration` once the assistant turn is fully complete.
			// We treat that (paired with at least one assistant message) as the
			// terminal signal.
			if (turnComplete && assistantMessages.length > 0) {
				return { sessionId: session.sessionId, assistantMessages };
			}
			if (this.now() >= deadline) {
				if (assistantMessages.length > 0) {
					return { sessionId: session.sessionId, assistantMessages };
				}
				throw new ClaudeTerminalTimeoutError(
					`timed out waiting for Claude assistant response in ${session.transcriptPath}`,
				);
			}
			await this.sleep(options.pollIntervalMs);
		}
	}
}

interface TranscriptScan {
	assistantMessages: TranscriptMessage[];
	lastResult: TranscriptMessage | undefined;
	turnComplete: boolean;
}

function scanTranscript(messages: TranscriptMessage[]): TranscriptScan {
	const assistantMessages: TranscriptMessage[] = [];
	let lastResult: TranscriptMessage | undefined;
	let turnComplete = false;
	for (const m of messages) {
		if (m.type === "assistant") {
			assistantMessages.push(m);
		} else if (m.type === "result") {
			lastResult = m;
		} else if (m.type === "system" && m.subtype === "turn_duration") {
			turnComplete = true;
		}
	}
	return { assistantMessages, lastResult, turnComplete };
}

export function parseJsonl(raw: string): TranscriptMessage[] {
	if (raw.length === 0) return [];
	const out: TranscriptMessage[] = [];
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (isTranscriptMessage(parsed)) {
			out.push(parsed);
		}
	}
	return out;
}

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
	if (typeof value !== "object" || value === null) return false;
	const t = (value as { type?: unknown }).type;
	return t === "assistant" || t === "user" || t === "result" || t === "system";
}
