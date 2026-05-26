import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
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
const DEFAULT_PASTE_VISIBLE_TIMEOUT_MS = 90 * 1000;
const DEFAULT_READY_POLL_INTERVAL_MS = 100;
const DEFAULT_READY_INDICATOR = "❯";
const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

// Upper bound on the cell width of the needle slice used to detect that the
// pasted prompt has rendered. Kept well below typical terminal widths (80+
// cells) so the needle stays on a single visual row even if the prompt is
// dense CJK text (each char ≈ 2 cells).
const MAX_NEEDLE_CELLS = 32;

const COLLAPSED_PASTE_PATTERNS: ReadonlyArray<RegExp> = [
	// `\s+` (incl. \n) between tokens is enough to absorb soft-wrap from a
	// narrow pane that breaks the citation across rows. Strict tokens between
	// (`text #N`, `+N`, `lines`) minimize false-positive surface vs the
	// previous `[^\]]*` greedy form, which would match e.g.
	// `[Pasted from clipboard: +2 columns and 3 lines]` in user content.
	/\[Pasted\s+text\s+#\d+\s+\+\d+\s+lines\]/,
	/\[Pasted\s+#\d+\]/,
	// Tentative Japanese-localization patterns; harmless if the actual TUI
	// string differs. Verify against a real session before relying on these.
	// sakoku-ignore-next-line
	/\[ペースト\s*#?\d*\s*\+\d+\s*行\]/,
	// sakoku-ignore-next-line
	/\[貼り付け\s*#?\d*\s*\+\d+\s*行\]/,
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches CSI/SGR escape sequences in tmux output
const ANSI_ESCAPE_PATTERN = /\x1b\[[\d;?]*[A-Za-z]/g;
// U+30FC (Japanese prolonged-sound mark) is intentionally EXCLUDED — it is a
// content character in many Japanese loanwords, not punctuation/decor.
// sakoku-ignore-next-line
const TRAILING_TRIM_PATTERN = /[\s*`_~。．、，！？!?,.;:　・]+$/u;
const LEADING_TRIM_PATTERN = /^[\s*`_~]+/u;

// Shared by waitForReady and waitForPasteVisible: after this many consecutive
// captureScreen rejections, give up and re-throw the underlying error.
const CAPTURE_FAILURE_LIMIT = 3;

export interface ClaudeTerminalSDKConfig {
	cwd?: string;
	backend?: "tmux";
	timeoutMs?: number;
	keepSession?: boolean;
	transcriptPollIntervalMs?: number;
	claudeBin?: string;
	tmuxBin?: string;
	transcriptRoot?: string;
	/**
	 * Permission mode forwarded to Claude as `--permission-mode <mode>`.
	 * Defaults to `"bypassPermissions"` because `claude-terminal` is an
	 * automation transport — the TUI has no way for the caller to answer
	 * tool-use permission prompts, so a non-bypass mode would hang.
	 */
	permissionMode?: PermissionMode;
	backendImpl?: TerminalBackend;
	transcriptReader?: ClaudeTranscriptReader;
	now?: () => Date;
	/**
	 * How long to wait for the Claude TUI input prompt to render after launch,
	 * before pasting the user's prompt. Throws a timeout error if the indicator
	 * never appears within this window.
	 */
	readyTimeoutMs?: number;
	/**
	 * How long to wait for the pasted prompt to appear in the TUI screen capture
	 * before submitting Enter. Intentionally decoupled from `timeoutMs` (which
	 * governs the overall response wait) so a stuck paste detection returns
	 * control to the caller quickly enough for an upper-layer retry. Defaults
	 * to 90s. Note: per-call `opts.timeoutMs` does NOT lift this — set it on
	 * the SDK instance config if you need a different ceiling.
	 */
	pasteVisibleTimeoutMs?: number;
	/** Poll interval (ms) when waiting for the TUI to become ready. */
	readyPollIntervalMs?: number;
	/**
	 * Substring expected in the tmux screen capture once Claude's TUI is ready
	 * to accept input. Defaults to U+276F (Claude Code's input prompt arrow).
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
		const timeoutMs =
			opts.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const pollIntervalMs =
			this.config.transcriptPollIntervalMs ??
			DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS;
		const transcriptRoot =
			this.config.transcriptRoot ?? defaultTranscriptRoot();
		const readyTimeoutMs =
			this.config.readyTimeoutMs ?? opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const pasteVisibleTimeoutMs =
			this.config.pasteVisibleTimeoutMs ?? DEFAULT_PASTE_VISIBLE_TIMEOUT_MS;
		const readyPollIntervalMs =
			this.config.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS;
		const readyIndicator =
			this.config.readyIndicator ?? DEFAULT_READY_INDICATOR;

		const cmdOpts: BuildClaudeCommandOptions = {
			claudeBin: this.config.claudeBin ?? "claude",
			permissionMode: this.config.permissionMode ?? DEFAULT_PERMISSION_MODE,
		};
		if (opts.model !== undefined) cmdOpts.model = opts.model;
		if (opts.systemPrompt !== undefined)
			cmdOpts.systemPrompt = opts.systemPrompt;
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
				timeoutMs: pasteVisibleTimeoutMs,
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
		const needles = buildNeedles(prompt);
		// Short-circuit BEFORE polling: an empty-needle prompt (truly empty /
		// whitespace-only) has nothing to verify on screen, so we skip the
		// captureScreen loop entirely. Probing pasteIsConsumed with an empty
		// screen is sufficient because the function's empty-needle branch
		// returns true without inspecting the screen at all.
		if (pasteIsConsumed("", needles)) return;
		const deadline = this.now().getTime() + opts.timeoutMs;
		let lastScreen = "";
		let consecutiveFailures = 0;
		while (true) {
			let screen = "";
			try {
				// Coerce against a misbehaving backend that resolves to
				// undefined / null (rather than rejecting) — normalizeForMatch
				// would otherwise throw TypeError on .replace, escaping this
				// catch block and bypassing the 3-strike retry path below.
				screen = (await this.backend.captureScreen(session)) ?? "";
				lastScreen = screen;
				consecutiveFailures = 0;
			} catch (err) {
				consecutiveFailures += 1;
				if (consecutiveFailures >= CAPTURE_FAILURE_LIMIT) {
					throw new ClaudeTerminalError(
						`captureScreen failed ${consecutiveFailures} times in a row while waiting for pasted prompt to render`,
						{ cause: err },
					);
				}
				screen = "";
			}
			if (pasteIsConsumed(screen, needles)) {
				return;
			}
			if (this.now().getTime() >= deadline) {
				throw new ClaudeTerminalTimeoutError(
					buildPasteVisibleTimeoutMessage(needles, lastScreen, opts.timeoutMs),
				);
			}
			await this.sleep(opts.pollIntervalMs);
		}
	}

	private async waitForReady(
		session: TerminalSession,
		opts: { indicator: string; timeoutMs: number; pollIntervalMs: number },
	): Promise<void> {
		const deadline = this.now().getTime() + opts.timeoutMs;
		let consecutiveFailures = 0;
		while (true) {
			let screen = "";
			try {
				screen = await this.backend.captureScreen(session);
				consecutiveFailures = 0;
			} catch (err) {
				consecutiveFailures += 1;
				if (consecutiveFailures >= CAPTURE_FAILURE_LIMIT) {
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

export interface PasteNeedles {
	readonly prefix: string;
	readonly suffix: string;
}

/** Build prefix/suffix needles used to detect that a pasted prompt has rendered. */
export function buildNeedles(prompt: string): PasteNeedles {
	return {
		prefix: prefixNeedle(prompt),
		suffix: suffixNeedle(prompt),
	};
}

function suffixNeedle(prompt: string): string {
	// Strip trailing volatile chars (Markdown decor, CJK/Latin punctuation,
	// whitespace) across the WHOLE prompt, not just the last line — a prompt
	// ending in a multi-line code fence (``` on its own line) would otherwise
	// yield a last-line of just three backticks, which is both useless (no
	// content) and a false-positive risk (any screen containing ``` matches).
	const trimmed = prompt.trimEnd();
	// Truly empty / whitespace-only prompt → empty needle (pasteIsConsumed
	// short-circuits to true so the run doesn't hang in waitForPasteVisible).
	if (trimmed.length === 0) return "";
	const stripped = trimmed.replace(TRAILING_TRIM_PATTERN, "");
	// Prompt is non-empty but consists entirely of trim-pattern chars
	// (decor/punctuation only, e.g. "```", "***", or runs of CJK full stops).
	// Fall back to a needle from the un-stripped lastLine — at least we verify SOMETHING
	// rendered before submitting Enter. Otherwise the empty-needle
	// short-circuit would skip screen verification entirely.
	const source = stripped.length === 0 ? trimmed : stripped;
	const lastLine = source.split("\n").at(-1) ?? "";
	if (lastLine.length === 0) return "";
	return takeSuffixByCellWidth(lastLine, MAX_NEEDLE_CELLS);
}

function prefixNeedle(prompt: string): string {
	const trimmed = prompt.trimStart();
	if (trimmed.length === 0) return "";
	const stripped = trimmed.replace(LEADING_TRIM_PATTERN, "");
	// Same fallback rationale as suffixNeedle: for an all-decor prompt, prefer
	// a real (if noisy) needle over the empty-needle short-circuit.
	const source = stripped.length === 0 ? trimmed : stripped;
	const firstLine = source.split("\n")[0] ?? "";
	if (firstLine.length === 0) return "";
	return takePrefixByCellWidth(firstLine, MAX_NEEDLE_CELLS);
}

/**
 * Rough cell-width estimate for a single code point. ASCII / Latin-1 letters
 * count as 1 cell; everything else counts as 2. Zero-width characters
 * (combining marks, ZWJ/ZWNJ, BOM, variation selectors) count as 0.
 * This is deliberately a coarse approximation — we only need to keep needles
 * from being twice as wide as expected when the prompt is CJK-heavy.
 */
function charCellWidth(codePoint: number): number {
	if (codePoint < 0x300) return 1;
	// Combining-mark blocks → zero width.
	if (codePoint >= 0x300 && codePoint <= 0x36f) return 0;
	if (codePoint >= 0x1ab0 && codePoint <= 0x1aff) return 0;
	if (codePoint >= 0x1dc0 && codePoint <= 0x1dff) return 0;
	if (codePoint >= 0x20d0 && codePoint <= 0x20ff) return 0;
	if (codePoint >= 0xfe20 && codePoint <= 0xfe2f) return 0;
	// Format / control characters that occupy no visible cell:
	// ZWSP, ZWNJ, ZWJ, LRM, RLM (0x200B–0x200F).
	if (codePoint >= 0x200b && codePoint <= 0x200f) return 0;
	if (codePoint === 0x2060) return 0; // WORD JOINER
	if (codePoint === 0xfeff) return 0; // BOM
	if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0; // variation selectors
	if (codePoint >= 0xe0100 && codePoint <= 0xe01ef) return 0; // var. selectors supplement
	return 2;
}

export function stringCellWidth(s: string): number {
	let w = 0;
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		w += charCellWidth(cp);
	}
	return w;
}

function takeSuffixByCellWidth(s: string, maxCells: number): string {
	const chars = Array.from(s);
	let width = 0;
	let start = chars.length;
	for (let i = chars.length - 1; i >= 0; i--) {
		const ch = chars[i] as string;
		const cp = ch.codePointAt(0);
		const w = cp === undefined ? 0 : charCellWidth(cp);
		if (width + w > maxCells) break;
		width += w;
		start = i;
	}
	// Skip leading zero-width characters so the needle starts on a base char.
	// An orphan combining mark (or trailing ZWJ from a broken emoji sequence)
	// would NFC-normalize differently than the same code point following its
	// base in the screen capture, defeating substring match.
	while (start < chars.length) {
		const ch = chars[start] as string;
		const cp = ch.codePointAt(0);
		if (cp === undefined) break;
		if (charCellWidth(cp) > 0) break;
		start++;
	}
	return chars.slice(start).join("");
}

function takePrefixByCellWidth(s: string, maxCells: number): string {
	const chars = Array.from(s);
	// Skip leading zero-width characters (same rationale as suffix).
	let begin = 0;
	while (begin < chars.length) {
		const ch = chars[begin] as string;
		const cp = ch.codePointAt(0);
		if (cp === undefined) break;
		if (charCellWidth(cp) > 0) break;
		begin++;
	}
	let width = 0;
	let end = begin;
	for (let i = begin; i < chars.length; i++) {
		const ch = chars[i] as string;
		const cp = ch.codePointAt(0);
		const w = cp === undefined ? 0 : charCellWidth(cp);
		if (width + w > maxCells) break;
		width += w;
		end = i + 1;
	}
	return chars.slice(begin, end).join("");
}

/**
 * Normalize text for fuzzy substring matching: strip ANSI escapes, NFC the
 * code points, then remove ALL whitespace. Removing whitespace (not merely
 * collapsing it) lets a contiguous CJK needle match a screen capture where
 * soft-wrap inserted line breaks mid-needle. Pasted prompts don't
 * intentionally span lines as part of the needle (we pick a short tail/head
 * slice from a single line), so collapsing whitespace away is safe.
 */
export function normalizeForMatch(s: string): string {
	return s
		.replace(ANSI_ESCAPE_PATTERN, "")
		.normalize("NFC")
		.replace(/\s+/g, "");
}

export function pasteIsConsumed(
	screen: string,
	needles: PasteNeedles,
): boolean {
	const normSuffix = normalizeForMatch(needles.suffix);
	const normPrefix = normalizeForMatch(needles.prefix);
	// Empty-needle invariant: with no content to verify (empty / whitespace /
	// pure-decor prompt), treat the paste as already consumed. Matches the
	// pre-refactor `screen.includes("")` => true behavior, so empty prompts
	// don't hang for the full `pasteVisibleTimeoutMs`.
	if (normSuffix.length === 0 && normPrefix.length === 0) return true;
	const normScreen = normalizeForMatch(screen);
	if (normSuffix.length > 0 && normScreen.includes(normSuffix)) return true;
	if (normPrefix.length > 0 && normScreen.includes(normPrefix)) return true;
	// Run citation regexes against BOTH raw and normalized screen so a citation
	// that soft-wraps mid-bracket is still detected via the normalized form.
	return COLLAPSED_PASTE_PATTERNS.some(
		(re) => re.test(screen) || re.test(normScreen),
	);
}

function buildPasteVisibleTimeoutMessage(
	needles: PasteNeedles,
	screen: string,
	timeoutMs: number,
): string {
	// Diagnostic uses the SAME normalization as the matching path
	// (normalizeForMatch) so the values printed here exactly reflect what was
	// compared in pasteIsConsumed — operators can grep the screen dump using
	// these strings without having to second-guess whitespace handling.
	const normPrefix = normalizeForMatch(needles.prefix);
	const normSuffix = normalizeForMatch(needles.suffix);
	const normScreen = normalizeForMatch(screen);
	const tail = normScreen.slice(-500);
	return [
		`timed out waiting for pasted prompt to appear in Claude TUI within ${timeoutMs}ms`,
		`  normalized prefix needle: ${JSON.stringify(normPrefix)}`,
		`  normalized suffix needle: ${JSON.stringify(normSuffix)}`,
		`  normalized screen length: ${normScreen.length}`,
		`  normalized screen tail (≤500 chars): ${JSON.stringify(tail)}`,
	].join("\n");
}
