import { describe, expect, test } from "bun:test";
import {
	buildNeedles,
	normalizeForMatch,
	pasteIsConsumed,
	stringCellWidth,
} from "./sdk.ts";

describe("buildNeedles", () => {
	test("uses a short prompt verbatim for both prefix and suffix", () => {
		const { prefix, suffix } = buildNeedles("hi");
		expect(prefix).toBe("hi");
		expect(suffix).toBe("hi");
	});

	test("limits the suffix to <= MAX_NEEDLE_CELLS visual columns for CJK text", () => {
		// sakoku-ignore-next-line
		const prompt = "これは日本語の長文プロンプトの末尾の検証です";
		const { suffix } = buildNeedles(prompt);
		expect(stringCellWidth(suffix)).toBeLessThanOrEqual(32);
		expect(suffix.length).toBeGreaterThan(0);
		expect(prompt.endsWith(suffix)).toBe(true);
	});

	test("trims trailing markdown decor and punctuation from the suffix", () => {
		// sakoku-ignore-next-line
		const prompt = "...セキュリティ脆弱性は検出されませんでした。**";
		const { suffix } = buildNeedles(prompt);
		expect(suffix.endsWith("**")).toBe(false);
		// sakoku-ignore-next-line
		expect(suffix.endsWith("。")).toBe(false);
		// sakoku-ignore-next-line
		expect(suffix).toContain("検出されませんでした");
	});

	test("preserves chōonpu (U+30FC) at the suffix tail — it is content, not decor", () => {
		// Common Japanese loanwords end in U+30FC (e.g., loanword for "server").
		// sakoku-ignore-next-line
		const prompt = "再起動するサーバー";
		const { suffix } = buildNeedles(prompt);
		// sakoku-ignore-next-line
		expect(suffix.endsWith("サーバー")).toBe(true);
	});

	test("uses the first line up to MAX_NEEDLE_CELLS for the prefix", () => {
		// sakoku-ignore-next-line
		const prompt = "見出し行\n本文の続き";
		const { prefix } = buildNeedles(prompt);
		// sakoku-ignore-next-line
		expect(prefix).toBe("見出し行");
	});

	test("strips leading Markdown decor from the prefix needle", () => {
		// sakoku-ignore-next-line
		const prompt = "**重要な見出し**\n本文";
		const { prefix } = buildNeedles(prompt);
		expect(prefix.startsWith("*")).toBe(false);
		// sakoku-ignore-next-line
		expect(prefix).toContain("重要な見出し");
	});

	test("strips a trailing code fence at the prompt level, not just last-line", () => {
		// Prompt that ends with a closing ``` fence on its own line.
		const prompt = "Explain this code:\n```python\nprint('hi')\n```";
		const { suffix } = buildNeedles(prompt);
		// Must NOT be just three backticks — that would match any screen with
		// backticks.
		expect(suffix).not.toBe("```");
		expect(suffix).toContain("print('hi')");
	});

	test("returns empty needles for empty / whitespace-only prompts", () => {
		for (const prompt of ["", "   ", "\n\n", " \t \n "]) {
			const { prefix, suffix } = buildNeedles(prompt);
			expect(prefix).toBe("");
			expect(suffix).toBe("");
		}
	});

	test("falls back to un-stripped needle for decor-only prompts (not empty)", () => {
		// A prompt consisting entirely of trim-pattern chars must NOT yield
		// empty needles — that would skip screen verification entirely via the
		// pasteIsConsumed short-circuit. We fall back to the trimmed (but
		// un-stripped) lastLine / firstLine so SOMETHING is checked.
		for (const prompt of ["```", "***", "!!!", "___"]) {
			const { prefix, suffix } = buildNeedles(prompt);
			expect(prefix.length).toBeGreaterThan(0);
			expect(suffix.length).toBeGreaterThan(0);
		}
	});

	test("counts ZWJ emoji sequences as a single grapheme (≤ 2 cells)", () => {
		// Family emoji: man + ZWJ + woman + ZWJ + girl. The visible grapheme is
		// ~2 cells wide, not 10. Our charCellWidth treats ZWJ as 0 and each
		// emoji codepoint as 2, but the OVERALL sequence should not blow past a
		// small cell-width budget. Concretely: stringCellWidth for the sequence
		// should be 6 (3 base * 2) with ZWJ at 0, NOT 10.
		const family = "👨‍👩‍👧";
		expect(stringCellWidth(family)).toBe(6);
	});
});

describe("normalizeForMatch", () => {
	test("strips ANSI SGR sequences", () => {
		expect(normalizeForMatch("\x1b[1mbold\x1b[0m text")).toBe("boldtext");
	});

	test("removes all whitespace (incl. newline soft-wraps)", () => {
		expect(normalizeForMatch("first\nsecond  third\n  fourth")).toBe(
			"firstsecondthirdfourth",
		);
	});

	test("NFC-normalizes precomposed vs decomposed forms", () => {
		// Precomposed dakuten kana vs base kana + combining dakuten via NFD.
		// sakoku-ignore-next-line
		const decomposed = "が";
		const nfd = decomposed.normalize("NFD");
		expect(normalizeForMatch(nfd)).toBe(normalizeForMatch(decomposed));
	});
});

describe("pasteIsConsumed", () => {
	test("matches a 24-char Japanese needle even when soft-wrapped at 48 columns", () => {
		// Reproduces the cruise failure: a 24-char Japanese needle occupies
		// approximately 48 cells, so an 80-col TUI wraps it in the middle. A
		// naive screen.includes would never match.
		const prompt =
			// sakoku-ignore-next-line
			"レビュー結果: 重大なセキュリティ脆弱性は検出されませんでした";
		const needles = buildNeedles(prompt);
		const wrapped =
			// sakoku-ignore-next-line
			`❯ レビュー結果: 重大\nなセキュリティ脆弱性は\n検出されませんでした`;
		// Sanity: a naive contains would miss this.
		expect(wrapped.includes(needles.suffix)).toBe(false);
		expect(pasteIsConsumed(wrapped, needles)).toBe(true);
	});

	test("matches across ANSI escape sequences embedded by tmux", () => {
		const prompt = "Analyze the task content carefully";
		const needles = buildNeedles(prompt);
		const screen = `❯ Analyze the \x1b[1mtask\x1b[0m content carefully`;
		expect(pasteIsConsumed(screen, needles)).toBe(true);
	});

	test("treats `[Pasted text #N +M lines]` as a paste-completion signal", () => {
		const prompt = `Analyze the task content. ${"x".repeat(200)} done.`;
		const needles = buildNeedles(prompt);
		const screen = "❯ Analyze the task content [Pasted text #1 +9 lines]";
		expect(pasteIsConsumed(screen, needles)).toBe(true);
	});

	test("detects an English citation that soft-wraps mid-bracket", () => {
		const prompt = `Analyze the task content. ${"x".repeat(200)} done.`;
		const needles = buildNeedles(prompt);
		// Narrow pane wraps the citation across rows.
		const screen = "❯ Analyze the task content [Pasted text #1\n +9 lines]";
		expect(pasteIsConsumed(screen, needles)).toBe(true);
	});

	test("falls back to the prefix needle when the suffix is collapsed away", () => {
		// sakoku-ignore-next-line
		const prompt = `見出し: 重要な指示\n${"x".repeat(300)} 末尾の文`;
		const needles = buildNeedles(prompt);
		// sakoku-ignore-next-line
		const screen = "❯ 見出し: 重要な指示 …";
		expect(pasteIsConsumed(screen, needles)).toBe(true);
	});

	test("recognizes a Japanese-localized collapsed-paste citation", () => {
		const prompt = `Analyze ${"x".repeat(200)} done.`;
		const needles = buildNeedles(prompt);
		// sakoku-ignore-next-line
		const screen = "❯ Analyze [ペースト #1 +9行]";
		expect(pasteIsConsumed(screen, needles)).toBe(true);
	});

	test("returns true immediately for empty / whitespace-only prompts", () => {
		// Empty needles must short-circuit so empty prompts don't hang for the
		// full pasteVisibleTimeoutMs (90s by default).
		for (const prompt of ["", "   ", "\n\n"]) {
			const needles = buildNeedles(prompt);
			expect(pasteIsConsumed("❯ ", needles)).toBe(true);
		}
	});

	test("does NOT match unrelated screen content", () => {
		// sakoku-ignore-next-line
		const prompt = "完全に独立したプロンプト本文の末尾";
		const needles = buildNeedles(prompt);
		expect(pasteIsConsumed("❯ ", needles)).toBe(false);
		expect(pasteIsConsumed("❯ another prompt entirely", needles)).toBe(false);
	});

	test("does NOT false-positive on a screen containing only backticks", () => {
		// Regression for C8: a prompt ending in a multi-line code fence used to
		// produce a 3-backtick fallback needle that matched any screen with
		// triple backticks. Now the suffix is taken from the non-decor content.
		const prompt = "Explain this code:\n```python\nprint('hi')\n```";
		const needles = buildNeedles(prompt);
		// Stale screen with only backticks (e.g., prior turn's output).
		const stale = "❯ ```\nthe prior turn's code block\n```";
		expect(pasteIsConsumed(stale, needles)).toBe(false);
	});
});
