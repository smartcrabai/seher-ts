import { describe, expect, test } from "bun:test";
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
});
