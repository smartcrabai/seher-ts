import { describe, expect, mock, test } from "bun:test";
import type { ParsedArgs } from "./cli/args.ts";
import { type RunSeherDeps, runSeher } from "./main.ts";

interface DepsBuildInput {
	parsed?: Partial<ParsedArgs>;
	resolvePrompt?: RunSeherDeps["resolvePrompt"];
	runBuildMode?: RunSeherDeps["runBuildMode"];
	runPlanMode?: RunSeherDeps["runPlanMode"];
}

function buildDeps(input: DepsBuildInput = {}): {
	deps: RunSeherDeps;
	stdout: string[];
	stderr: string[];
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const parsed: ParsedArgs = {
		mode: "build",
		quiet: false,
		help: false,
		version: false,
		trailing: [],
		...input.parsed,
	};
	const deps: RunSeherDeps = {
		parseArgs: mock(() => parsed),
		resolvePrompt: input.resolvePrompt ?? mock(async () => "the prompt"),
		runBuildMode:
			input.runBuildMode ?? mock(async () => ({ exitCode: 0, text: "" })),
		runPlanMode: input.runPlanMode ?? mock(async () => ({ exitCode: 0 })),
		stdout: (text) => {
			stdout.push(text);
		},
		stderr: (text) => {
			stderr.push(text);
		},
	};
	return { deps, stdout, stderr };
}

describe("runSeher", () => {
	test("--help prints captured help text and exits 0", async () => {
		const { deps, stdout } = buildDeps({
			parsed: { help: true, output: "Usage: seher [options]\n" },
		});
		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(stdout.join("")).toContain("Usage: seher");
	});

	test("--version prints captured version text and exits 0", async () => {
		const { deps, stdout } = buildDeps({
			parsed: { version: true, output: "0.1.0\n" },
		});
		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(stdout.join("")).toContain("0.1.0");
	});

	test("build mode dispatches to runBuildMode with the resolved prompt", async () => {
		const runBuildMode = mock(async () => ({ exitCode: 7, text: "" }));
		const { deps } = buildDeps({
			parsed: { mode: "build", trailing: ["hi"], provider: "claude" },
			resolvePrompt: mock(async () => "hi there"),
			runBuildMode: runBuildMode as unknown as RunSeherDeps["runBuildMode"],
		});
		const code = await runSeher([], deps);
		expect(code).toBe(7);
		expect(runBuildMode).toHaveBeenCalledTimes(1);
		const callArgs = runBuildMode.mock.calls[0] as unknown as [
			{ prompt: string; provider?: string },
		];
		expect(callArgs[0].prompt).toBe("hi there");
		expect(callArgs[0].provider).toBe("claude");
	});

	test("plan mode dispatches to runPlanMode", async () => {
		const runPlanMode = mock(async () => ({ exitCode: 0 }));
		const { deps } = buildDeps({
			parsed: { mode: "plan", trailing: ["plan", "this"] },
			resolvePrompt: mock(async () => "plan this"),
			runPlanMode: runPlanMode as unknown as RunSeherDeps["runPlanMode"],
		});
		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(runPlanMode).toHaveBeenCalledTimes(1);
		const callArgs = runPlanMode.mock.calls[0] as unknown as [
			{ prompt: string },
		];
		expect(callArgs[0].prompt).toBe("plan this");
	});

	test("--model rebinds the build mode key", async () => {
		const runBuildMode = mock(async () => ({ exitCode: 0, text: "" }));
		const { deps } = buildDeps({
			parsed: { mode: "build", model: "low" },
			resolvePrompt: mock(async () => "x"),
			runBuildMode: runBuildMode as unknown as RunSeherDeps["runBuildMode"],
		});
		await runSeher([], deps);
		const callArgs = runBuildMode.mock.calls[0] as unknown as [
			{ mode?: string },
		];
		expect(callArgs[0].mode).toBe("low");
	});

	test("empty prompt returns 1 with stderr message", async () => {
		const { deps, stderr } = buildDeps({
			resolvePrompt: mock(async () => null),
		});
		const code = await runSeher([], deps);
		expect(code).toBe(1);
		expect(stderr.join("")).toContain("Empty prompt");
	});
});
