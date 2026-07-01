import { describe, expect, mock, test } from "bun:test";
import {
	type AgentLimit,
	AllAgentsLimitedError,
	type Config,
	NoMatchingAgentError,
	type ResolvedAgent,
} from "@seher-ts/sdk";
import { createLogger } from "../util/logger.ts";
import { runShowResolutionMode } from "./show-resolution.ts";

/**
 * Helper to build a minimal `Config` for tests.
 * The SDK's `mkConfig` is treated as a test utility and isn't exported,
 * so we reimplement it locally here.
 */
function mkConfig(
	...providers: Array<
		Omit<Config["providers"][number], "provider"> & { provider?: string }
	>
): Config {
	return {
		providers: providers.map((p) => ({
			...p,
			provider: p.provider ?? p.key,
		})),
	};
}

interface Harness {
	stderr: string[];
	stdout: string[];
}

function newHarness(): Harness & {
	push: { stderr: (text: string) => void; stdout: (text: string) => void };
	logger: ReturnType<typeof createLogger>;
} {
	const stderr: string[] = [];
	const stdout: string[] = [];
	const pushStderr = (text: string) => {
		stderr.push(text);
	};
	const pushStdout = (text: string) => {
		stdout.push(text);
	};
	return {
		stderr,
		stdout,
		push: { stderr: pushStderr, stdout: pushStdout },
		logger: createLogger({ quiet: true, stderr: pushStderr }),
	};
}

describe("runShowResolutionMode", () => {
	test("prints the winner as JSON to stdout and the candidate list to stderr", async () => {
		const config: Config = mkConfig(
			{
				key: "codex",
				order: 0,
				sdk: "codex",
				models: { build: { model: "gpt-5.5", priority: 4 } },
			},
			{
				key: "claude",
				order: 1,
				sdk: "claude",
				priority: 3,
				models: { build: { model: "sonnet" } },
			},
		);
		const h = newHarness();
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const loadConfig = mock(async (): Promise<Config> => config);
		const resolveAgent = mock(
			async (): Promise<ResolvedAgent> => ({
				provider: "codex",
				kind: "codex",
				modelId: "gpt-5.5",
				modeKey: "build",
				env: {},
				skills: { includeClaude: true },
			}),
		);

		const result = await runShowResolutionMode({
			mode: "build",
			logger: h.logger,
			stderr: h.push.stderr,
			stdout: h.push.stdout,
			loadConfig,
			checkLimit,
			resolveAgent,
		});

		expect(result.exitCode).toBe(0);
		const stderr = h.stderr.join("");
		expect(stderr).toContain("Candidates (mode=build):");
		expect(stderr).toContain("0. codex (sdk=codex, model=gpt-5.5, priority=4)");
		expect(stderr).toContain(
			"1. claude (sdk=claude, model=sonnet, priority=3)",
		);
		const stdout = h.stdout.join("");
		const parsed = JSON.parse(stdout) as Record<string, string>;
		expect(parsed).toEqual({
			provider: "codex",
			model: "gpt-5.5",
			sdk: "codex",
			mode: "build",
		});
		// stdout should end with a newline.
		expect(stdout.endsWith("\n")).toBe(true);
	});

	test("candidates/winner with effort set display effort=<level>", async () => {
		const config: Config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			priority: 3,
			models: { build: { model: "sonnet", effort: "high" } },
		});
		const h = newHarness();
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const loadConfig = mock(async (): Promise<Config> => config);
		const resolveAgent = mock(
			async (): Promise<ResolvedAgent> => ({
				provider: "claude",
				kind: "claude",
				modelId: "sonnet",
				modeKey: "build",
				env: {},
				skills: { includeClaude: true },
				effort: "high",
			}),
		);

		const result = await runShowResolutionMode({
			mode: "build",
			logger: h.logger,
			stderr: h.push.stderr,
			stdout: h.push.stdout,
			loadConfig,
			checkLimit,
			resolveAgent,
		});

		expect(result.exitCode).toBe(0);
		const stderr = h.stderr.join("");
		expect(stderr).toContain(
			"0. claude (sdk=claude, model=sonnet, priority=3, effort=high)",
		);
		const stdout = h.stdout.join("");
		const parsed = JSON.parse(stdout) as Record<string, string>;
		expect(parsed).toEqual({
			provider: "claude",
			model: "sonnet",
			sdk: "claude",
			mode: "build",
			effort: "high",
		});
	});

	test("limited candidates get a [LIMITED until ...] tag", async () => {
		const config: Config = mkConfig({
			key: "codex",
			order: 0,
			sdk: "codex",
			models: { build: { model: "gpt-5.5", priority: 4 } },
		});
		const h = newHarness();
		const resetTime = new Date("2026-06-28T12:55:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime }),
		);
		// Since it's limited, resolveAgent is expected to throw AllAgentsLimitedError.
		const resolveAgent = mock(async (): Promise<ResolvedAgent> => {
			throw new AllAgentsLimitedError(resetTime);
		});
		const loadConfig = mock(async (): Promise<Config> => config);

		const result = await runShowResolutionMode({
			mode: "build",
			logger: h.logger,
			stderr: h.push.stderr,
			stdout: h.push.stdout,
			loadConfig,
			checkLimit,
			resolveAgent,
		});

		expect(result.exitCode).toBe(1);
		const stderr = h.stderr.join("");
		expect(stderr).toContain("[LIMITED until ");
		// It should include the trailing "]".
		expect(stderr).toMatch(/\[LIMITED until [^\]]+\]/);
		// The AllAgentsLimitedError message should be printed to stderr.
		expect(stderr).toContain("rate-limited");
		// No winner is printed.
		expect(h.stdout.join("")).toBe("");
	});

	test("a probe error adds a [probe error] tag but the winner is still printed", async () => {
		const config: Config = mkConfig({
			key: "codex",
			order: 0,
			sdk: "codex",
			models: { build: { model: "gpt-5.5", priority: 4 } },
		});
		const h = newHarness();
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			throw new Error("spawn failed");
		});
		const loadConfig = mock(async (): Promise<Config> => config);
		const resolveAgent = mock(
			async (): Promise<ResolvedAgent> => ({
				provider: "codex",
				kind: "codex",
				modelId: "gpt-5.5",
				modeKey: "build",
				env: {},
				skills: { includeClaude: true },
			}),
		);

		const result = await runShowResolutionMode({
			mode: "build",
			logger: h.logger,
			stderr: h.push.stderr,
			stdout: h.push.stdout,
			loadConfig,
			checkLimit,
			resolveAgent,
		});

		expect(result.exitCode).toBe(0);
		expect(h.stderr.join("")).toContain("[probe error]");
	});

	test("with zero candidates, only prints a warning and exits 1 via NoMatchingAgentError", async () => {
		const config: Config = { providers: [] };
		const h = newHarness();
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const loadConfig = mock(async (): Promise<Config> => config);
		const resolveAgent = mock(async (): Promise<ResolvedAgent> => {
			throw new NoMatchingAgentError("No providers define models.build");
		});

		const result = await runShowResolutionMode({
			mode: "build",
			logger: h.logger,
			stderr: h.push.stderr,
			stdout: h.push.stdout,
			loadConfig,
			checkLimit,
			resolveAgent,
		});

		expect(result.exitCode).toBe(1);
		const stderr = h.stderr.join("");
		expect(stderr).toContain("No candidates for mode key 'build'");
		expect(stderr).toContain("No providers define models.build");
	});

	test("the --provider filter is passed as the provider option", async () => {
		const config: Config = mkConfig(
			{
				key: "codex",
				order: 0,
				sdk: "codex",
				models: { build: { model: "gpt-5.5", priority: 4 } },
			},
			{
				key: "claude",
				order: 1,
				sdk: "claude",
				priority: 3,
				models: { build: { model: "sonnet" } },
			},
		);
		const h = newHarness();
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const loadConfig = mock(async (): Promise<Config> => config);
		const resolveAgent = mock(
			async (): Promise<ResolvedAgent> => ({
				provider: "claude",
				kind: "claude",
				modelId: "sonnet",
				modeKey: "build",
				env: {},
				skills: { includeClaude: true },
			}),
		);

		const result = await runShowResolutionMode({
			mode: "build",
			provider: "claude",
			logger: h.logger,
			stderr: h.push.stderr,
			stdout: h.push.stdout,
			loadConfig,
			checkLimit,
			resolveAgent,
		});

		expect(result.exitCode).toBe(0);
		// The candidates filter excludes codex, leaving only claude.
		const stderr = h.stderr.join("");
		expect(stderr).toContain(
			"0. claude (sdk=claude, model=sonnet, priority=3)",
		);
		expect(stderr).not.toContain("codex");
		// resolveAgent receives provider=claude.
		const callArgs = resolveAgent.mock.calls[0] as unknown as [
			{ provider?: string },
		];
		expect(callArgs[0].provider).toBe("claude");
	});
});
