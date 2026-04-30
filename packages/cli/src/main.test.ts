import { describe, expect, mock, test } from "bun:test";
import {
	type AgentConfig,
	type AgentLimit,
	type PriorityRule,
	type ProviderConfig,
	resolveAgent,
	type Settings,
} from "@seher-ts/sdk";
import { type RunSeherDeps, runSeher } from "./main.ts";

const INFERRED: ProviderConfig = { kind: "inferred" };
const NO_PROVIDER: ProviderConfig = { kind: "none" };

function mkAgent(
	command: string,
	provider: ProviderConfig = INFERRED,
): AgentConfig {
	return {
		command,
		args: [],
		models: null,
		arg_maps: {},
		env: null,
		provider,
		pre_command: [],
		active: null,
		inactive: null,
	};
}

function mkPriority(
	command: string,
	priority: number,
	model: string | null = null,
): PriorityRule {
	return { command, provider: INFERRED, model, priority };
}

interface DepsBuildInput {
	settings?: Settings;
	parsed?: Partial<ReturnType<RunSeherDeps["parseArgs"]>>;
	checkLimit?: RunSeherDeps["checkLimit"];
	runAgent?: RunSeherDeps["runAgent"];
	sleepUntil?: RunSeherDeps["sleepUntil"];
	startWebServer?: RunSeherDeps["startWebServer"];
	resolvePrompt?: RunSeherDeps["resolvePrompt"];
}

function buildDeps(input: DepsBuildInput = {}): {
	deps: RunSeherDeps;
	stdout: string[];
	stderr: string[];
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const parsed: ReturnType<RunSeherDeps["parseArgs"]> = {
		quiet: false,
		json: false,
		priority: false,
		guiConfig: false,
		help: false,
		version: false,
		trailing: [],
		...input.parsed,
	};
	const deps: RunSeherDeps = {
		parseArgs: mock(() => parsed),
		loadSettings: mock(
			async () => input.settings ?? { agents: [], priority: [] },
		),
		filterAgents: mock((agents: AgentConfig[]) => agents),
		sortByPriority: mock((agents: AgentConfig[]) => agents),
		checkLimit:
			input.checkLimit ?? mock(async () => ({ kind: "not_limited" as const })),
		resolvePrompt: input.resolvePrompt ?? mock(async () => null),
		runAgent: input.runAgent ?? mock(async () => ({ exitCode: 0 })),
		sleepUntil: input.sleepUntil ?? mock(async () => {}),
		resolveAgent,
		startWebServer: input.startWebServer ?? mock(async () => {}),
		now: () => new Date("2025-01-01T00:00:00Z"),
		stdout: (line) => {
			stdout.push(line);
		},
		stderr: (line) => {
			stderr.push(line);
		},
	};
	return { deps, stdout, stderr };
}

describe("runSeher", () => {
	test("--priority prints priority order and exits 0", async () => {
		const priority: PriorityRule[] = [
			mkPriority("claude", 100),
			mkPriority("codex", 50),
		];
		const { deps, stdout } = buildDeps({
			settings: { agents: [], priority },
			parsed: { priority: true },
		});

		const code = await runSeher([], deps);
		expect(code).toBe(0);
		const joined = stdout.join("\n");
		expect(joined).toContain("Priority order:");
		expect(joined).toContain("command=claude");
		expect(joined).toContain("command=codex");
	});

	test("--json outputs JSON-formatted agent statuses", async () => {
		const agents = [
			mkAgent("claude", { kind: "explicit", name: "anthropic" }),
			mkAgent("codex", { kind: "explicit", name: "openai" }),
		];
		const checkLimit = mock(async (_p: string) => ({
			kind: "not_limited" as const,
		})) as unknown as RunSeherDeps["checkLimit"];
		const { deps, stdout } = buildDeps({
			settings: { agents, priority: [] },
			parsed: { json: true },
			checkLimit,
		});

		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(stdout.length).toBe(1);
		const parsed = JSON.parse(stdout[0] as string);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].command).toBe("claude");
		expect(parsed[0].provider).toBe("anthropic");
		expect(parsed[1].command).toBe("codex");
		expect(parsed[1].provider).toBe("openai");
	});

	test("runs the first available agent and returns its exit code", async () => {
		const agents = [mkAgent("claude"), mkAgent("codex")];
		const runAgent = mock(async () => ({ exitCode: 42 }));
		const { deps } = buildDeps({
			settings: { agents, priority: [] },
			runAgent,
		});

		const code = await runSeher([], deps);
		expect(code).toBe(42);
		expect(runAgent).toHaveBeenCalledTimes(1);
		const callArgs = (
			runAgent.mock.calls as unknown as [AgentConfig, unknown][]
		)[0];
		expect(callArgs?.[0]?.command).toBe("claude");
	});

	test("sleeps when all agents are limited, then retries", async () => {
		const agents = [mkAgent("claude")];
		const reset = new Date("2099-01-01T00:00:00Z");
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			return calls === 1
				? { kind: "limited", resetTime: reset }
				: { kind: "not_limited" };
		}) as unknown as RunSeherDeps["checkLimit"];
		const sleepUntil = mock(async () => {});
		const runAgent = mock(async () => ({ exitCode: 0 }));
		const { deps } = buildDeps({
			settings: { agents, priority: [] },
			parsed: { quiet: true },
			checkLimit,
			sleepUntil,
			runAgent,
		});

		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(sleepUntil).toHaveBeenCalledTimes(1);
		const sleepArgs = (
			sleepUntil.mock.calls as unknown as [Date, unknown][]
		)[0];
		expect(sleepArgs?.[0]?.getTime()).toBe(reset.getTime());
		expect(runAgent).toHaveBeenCalledTimes(1);
	});

	test("gives up after max rescans when still limited", async () => {
		const agents = [mkAgent("claude")];
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime: reset }),
		) as unknown as RunSeherDeps["checkLimit"];
		const sleepUntil = mock(async () => {});
		const runAgent = mock(async () => ({ exitCode: 0 }));
		const { deps } = buildDeps({
			settings: { agents, priority: [] },
			parsed: { quiet: true },
			checkLimit,
			sleepUntil,
			runAgent,
		});

		const code = await runSeher([], deps);
		expect(code).toBe(1);
		expect(runAgent).toHaveBeenCalledTimes(0);
	});

	test("--gui-config starts the web server and exits 0", async () => {
		const startWebServer = mock(async () => {});
		const { deps } = buildDeps({
			parsed: { guiConfig: true },
			startWebServer,
		});
		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(startWebServer).toHaveBeenCalledTimes(1);
		const callArgs = (
			startWebServer.mock.calls as unknown as [{ settingsPath: string }][]
		)[0];
		expect(callArgs?.[0]?.settingsPath).toMatch(/settings\.jsonc$/);
	});

	test("returns 1 with stderr message when no agents are available after filter", async () => {
		const { deps, stderr } = buildDeps({
			settings: { agents: [], priority: [] },
		});
		const code = await runSeher([], deps);
		expect(code).toBe(1);
		expect(stderr.join("\n")).toContain("No agents match");
	});

	test("--help prints captured help text and exits 0 without loading settings", async () => {
		const loadSettings = mock(async () => ({ agents: [], priority: [] }));
		const { deps, stdout } = buildDeps({
			parsed: { help: true, output: "Usage: seher [options]\n" },
		});
		deps.loadSettings = loadSettings;
		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(stdout.join("\n")).toContain("Usage: seher");
		expect(loadSettings).toHaveBeenCalledTimes(0);
	});

	test("--version prints captured version text and exits 0", async () => {
		const { deps, stdout } = buildDeps({
			parsed: { version: true, output: "0.1.0\n" },
		});
		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(stdout.join("\n")).toContain("0.1.0");
	});

	test("agents with provider.kind='none' skip checkLimit and run directly", async () => {
		const agents = [mkAgent("fallback", NO_PROVIDER)];
		const checkLimit = mock(async () => ({
			kind: "not_limited" as const,
		})) as unknown as RunSeherDeps["checkLimit"];
		const runAgent = mock(async () => ({ exitCode: 7 }));
		const { deps } = buildDeps({
			settings: { agents, priority: [] },
			checkLimit,
			runAgent,
		});
		const code = await runSeher([], deps);
		expect(code).toBe(7);
		expect(checkLimit).toHaveBeenCalledTimes(0);
		expect(runAgent).toHaveBeenCalledTimes(1);
	});
});
