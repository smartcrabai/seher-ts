import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
	test("parses short/long flags with trailing after --", () => {
		const result = parseArgs([
			"-b",
			"chrome",
			"-m",
			"high",
			"--",
			"some",
			"prompt",
		]);
		expect(result.browser).toBe("chrome");
		expect(result.model).toBe("high");
		expect(result.trailing).toEqual(["some", "prompt"]);
		expect(result.quiet).toBe(false);
		expect(result.json).toBe(false);
		expect(result.priority).toBe(false);
		expect(result.guiConfig).toBe(false);
	});

	test("--json sets json flag", () => {
		const result = parseArgs(["--json"]);
		expect(result.json).toBe(true);
		expect(result.quiet).toBe(false);
	});

	test("--priority sets priority flag", () => {
		const result = parseArgs(["--priority"]);
		expect(result.priority).toBe(true);
	});

	test("--gui-config sets guiConfig flag", () => {
		const result = parseArgs(["--gui-config"]);
		expect(result.guiConfig).toBe(true);
	});

	test("empty argv yields defaults", () => {
		const result = parseArgs([]);
		expect(result.browser).toBeUndefined();
		expect(result.profile).toBeUndefined();
		expect(result.command).toBeUndefined();
		expect(result.provider).toBeUndefined();
		expect(result.model).toBeUndefined();
		expect(result.config).toBeUndefined();
		expect(result.quiet).toBe(false);
		expect(result.json).toBe(false);
		expect(result.priority).toBe(false);
		expect(result.guiConfig).toBe(false);
		expect(result.trailing).toEqual([]);
	});

	test("accepts --profile, --command, --provider, -C", () => {
		const result = parseArgs([
			"--profile",
			"Profile 1",
			"--command",
			"claude",
			"--provider",
			"copilot",
			"-C",
			"/tmp/settings.toml",
		]);
		expect(result.profile).toBe("Profile 1");
		expect(result.command).toBe("claude");
		expect(result.provider).toBe("copilot");
		expect(result.config).toBe("/tmp/settings.toml");
	});

	test("-q sets quiet", () => {
		const result = parseArgs(["-q"]);
		expect(result.quiet).toBe(true);
	});

	test("positional args before -- are trailing too", () => {
		const result = parseArgs(["-q", "hello", "world"]);
		expect(result.quiet).toBe(true);
		expect(result.trailing).toEqual(["hello", "world"]);
	});

	test("trailing preserves hyphenated values after --", () => {
		const result = parseArgs(["--", "--foo", "bar"]);
		expect(result.trailing).toEqual(["--foo", "bar"]);
	});

	test("-h sets help and captures help text", () => {
		const result = parseArgs(["-h"]);
		expect(result.help).toBe(true);
		expect(result.version).toBe(false);
		expect(result.output ?? "").toContain("Usage: seher");
	});

	test("--help sets help and captures help text", () => {
		const result = parseArgs(["--help"]);
		expect(result.help).toBe(true);
		expect(result.output ?? "").toContain("--help");
	});

	test("-v sets version and captures the version string", () => {
		const result = parseArgs(["-v"]);
		expect(result.version).toBe(true);
		expect(result.help).toBe(false);
		expect(result.output ?? "").toMatch(/\d+\.\d+\.\d+/);
	});

	test("--version sets version and captures the version string", () => {
		const result = parseArgs(["--version"]);
		expect(result.version).toBe(true);
		expect(result.output ?? "").toMatch(/\d+\.\d+\.\d+/);
	});
});
