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
 * テスト用の最小限の `Config` を組み立てるヘルパー。
 * SDK の `mkConfig` は test ユーティリティ扱いで export されていないので、
 * ここでローカルに再実装する。
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
	test("勝者を stdout に JSON で出力し、候補一覧を stderr に出す", async () => {
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
		// stdout の末尾は改行であること。
		expect(stdout.endsWith("\n")).toBe(true);
	});

	test("limited な候補には [LIMITED until ...] タグが付く", async () => {
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
		// limited なので resolveAgent は AllAgentsLimitedError を投げる想定。
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
		// 末尾の "]" まで含まれていること。
		expect(stderr).toMatch(/\[LIMITED until [^\]]+\]/);
		// AllAgentsLimitedError のメッセージが stderr に出ること。
		expect(stderr).toContain("rate-limited");
		// 勝者は出ない。
		expect(h.stdout.join("")).toBe("");
	});

	test("probe error が起きたら [probe error] タグが付くが winner は出る", async () => {
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

	test("候補ゼロのとき警告だけ出して NoMatchingAgentError で exit 1", async () => {
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

	test("--provider フィルタは provider オプションとして渡される", async () => {
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
		// candidates の絞り込みで codex は除外され、claude のみ残る。
		const stderr = h.stderr.join("");
		expect(stderr).toContain(
			"0. claude (sdk=claude, model=sonnet, priority=3)",
		);
		expect(stderr).not.toContain("codex");
		// resolveAgent には provider=claude が渡る。
		const callArgs = resolveAgent.mock.calls[0] as unknown as [
			{ provider?: string },
		];
		expect(callArgs[0].provider).toBe("claude");
	});
});
