import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
	test("defaults to build mode when no subcommand is given", () => {
		const result = parseArgs(["hello"]);
		expect(result.mode).toBe("build");
		expect(result.trailing).toEqual(["hello"]);
		expect(result.quiet).toBe(false);
	});

	test("explicit build subcommand", () => {
		const result = parseArgs(["build", "hello"]);
		expect(result.mode).toBe("build");
		expect(result.trailing).toEqual(["hello"]);
	});

	test("plan subcommand", () => {
		const result = parseArgs(["plan", "implement", "X"]);
		expect(result.mode).toBe("plan");
		expect(result.trailing).toEqual(["implement", "X"]);
	});

	test("--provider, --model, --config", () => {
		const result = parseArgs([
			"-p",
			"claude",
			"-m",
			"low",
			"-c",
			"/tmp/config.yaml",
			"hi",
		]);
		expect(result.mode).toBe("build");
		expect(result.provider).toBe("claude");
		expect(result.model).toBe("low");
		expect(result.config).toBe("/tmp/config.yaml");
		expect(result.trailing).toEqual(["hi"]);
	});

	test("plan with --provider", () => {
		const result = parseArgs(["plan", "--provider", "codex", "do", "thing"]);
		expect(result.mode).toBe("plan");
		expect(result.provider).toBe("codex");
		expect(result.trailing).toEqual(["do", "thing"]);
	});

	test("-q sets quiet", () => {
		const result = parseArgs(["-q", "hi"]);
		expect(result.quiet).toBe(true);
	});

	test("--help captures help text", () => {
		const result = parseArgs(["--help"]);
		expect(result.help).toBe(true);
		expect(result.output ?? "").toContain("plan");
		expect(result.output ?? "").toContain("build");
		expect(result.output ?? "").toContain("--provider");
	});

	test("-h captures help text with all options", () => {
		const result = parseArgs(["-h"]);
		expect(result.help).toBe(true);
		expect(result.output ?? "").toContain("--provider");
		expect(result.output ?? "").toContain("--model");
		expect(result.output ?? "").toContain("--config");
		expect(result.output ?? "").toContain("--quiet");
		expect(result.output ?? "").toContain("--version");
		expect(result.output ?? "").toContain("--help");
	});

	test("plan --help captures plan help text", () => {
		const result = parseArgs(["plan", "--help"]);
		expect(result.help).toBe(true);
		expect(result.output ?? "").toContain("--provider");
	});

	test("--version captures version string", () => {
		const result = parseArgs(["--version"]);
		expect(result.version).toBe(true);
		expect(result.output ?? "").toMatch(/\d+\.\d+\.\d+/);
	});

	test("empty argv yields build mode with no trailing", () => {
		const result = parseArgs([]);
		expect(result.mode).toBe("build");
		expect(result.trailing).toEqual([]);
		expect(result.quiet).toBe(false);
	});

	test("--timeout parses positive integer ms", () => {
		const result = parseArgs(["--timeout", "600000", "hi"]);
		expect(result.timeoutMs).toBe(600_000);
		expect(result.trailing).toEqual(["hi"]);
	});

	test("-t short flag", () => {
		const result = parseArgs(["-t", "5000", "hi"]);
		expect(result.timeoutMs).toBe(5000);
	});

	test("--timeout omitted leaves timeoutMs undefined", () => {
		const result = parseArgs(["hi"]);
		expect(result.timeoutMs).toBeUndefined();
	});

	test("--timeout rejects non-numeric value", () => {
		expect(() => parseArgs(["--timeout", "abc", "hi"])).toThrow(
			/Invalid --timeout/,
		);
	});

	test("--timeout rejects zero", () => {
		expect(() => parseArgs(["--timeout", "0", "hi"])).toThrow(
			/Invalid --timeout/,
		);
	});

	test("--timeout rejects negative", () => {
		expect(() => parseArgs(["--timeout", "-100", "hi"])).toThrow(
			/Invalid --timeout/,
		);
	});

	test("--timeout rejects fractional", () => {
		expect(() => parseArgs(["--timeout", "1.5", "hi"])).toThrow(
			/Invalid --timeout/,
		);
	});

	test("help includes --timeout", () => {
		const result = parseArgs(["--help"]);
		expect(result.output ?? "").toContain("--timeout");
	});

	// --- --cwd ---
	test("--cwd canonicalizes the path (resolves symlinks)", () => {
		// macOS の `/tmp` は `/private/tmp` への symlink。canonicalize 後は
		// `/private/tmp` になることを確認する。
		const result = parseArgs(["--cwd", "/tmp", "hi"]);
		const expected = realpathSync.native("/tmp");
		expect(result.cwd).toBe(expected);
	});

	test("--cwd rejects a nonexistent directory", () => {
		expect(() =>
			parseArgs(["--cwd", "/nonexistent-dir-xyz-zzz", "hi"]),
		).toThrow(/Invalid --cwd/);
	});

	test("--cwd rejects a regular file", () => {
		// 任意のファイルパスを使う: __filename 相当が無いので process.argv[1] 経由で
		// 確実に存在するファイルを使う。
		const filePath = process.argv[1] ?? "/etc/hosts";
		expect(() => parseArgs(["--cwd", filePath, "hi"])).toThrow(/Invalid --cwd/);
	});

	test("help text includes --cwd", () => {
		const result = parseArgs(["--help"]);
		expect(result.output ?? "").toContain("--cwd");
	});

	// --- --resume ---
	test("--resume accepts uuid-like ids", () => {
		const result = parseArgs([
			"-r",
			"963f3c95-78ba-472a-8adf-a5218af2d135",
			"hi",
		]);
		expect(result.resume).toBe("963f3c95-78ba-472a-8adf-a5218af2d135");
	});

	test("--resume accepts underscores and mixed alphanumerics", () => {
		const result = parseArgs(["--resume", "abc_123-XYZ", "hi"]);
		expect(result.resume).toBe("abc_123-XYZ");
	});

	test("--resume rejects path separators", () => {
		expect(() => parseArgs(["-r", "../../../etc/passwd", "hi"])).toThrow(
			/Invalid --resume/,
		);
		expect(() => parseArgs(["-r", "a/b", "hi"])).toThrow(/Invalid --resume/);
	});

	test("--resume rejects empty value via '='", () => {
		expect(() => parseArgs(["--resume=", "hi"])).toThrow(/Invalid --resume/);
	});

	test("help text includes --resume", () => {
		const result = parseArgs(["--help"]);
		expect(result.output ?? "").toContain("--resume");
	});

	test("--help defers cwd/resume validation so help still prints", () => {
		const result = parseArgs([
			"--cwd",
			"/nonexistent-xyz",
			"--resume",
			"bad/id",
			"--help",
		]);
		expect(result.help).toBe(true);
		expect(result.output ?? "").toContain("--cwd");
		// 値検証を skip しているので throw しない / cwd / resume はセットされない。
		expect(result.cwd).toBeUndefined();
		expect(result.resume).toBeUndefined();
	});

	// --- --show-resolution ---
	test("--show-resolution sets showResolution=true", () => {
		const result = parseArgs(["--show-resolution"]);
		expect(result.showResolution).toBe(true);
		// prompt 不要のフラグなので trailing は空のまま。
		expect(result.trailing).toEqual([]);
	});

	test("showResolution defaults to false when --show-resolution omitted", () => {
		const result = parseArgs(["hi"]);
		expect(result.showResolution).toBe(false);
	});

	test("--show-resolution combines with -m and -p", () => {
		const result = parseArgs([
			"--show-resolution",
			"-m",
			"plan",
			"-p",
			"codex",
		]);
		expect(result.showResolution).toBe(true);
		expect(result.model).toBe("plan");
		expect(result.provider).toBe("codex");
	});

	test("help includes --show-resolution", () => {
		const result = parseArgs(["--help"]);
		expect(result.output ?? "").toContain("--show-resolution");
	});
});
