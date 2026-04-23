import { describe, expect, mock, test } from "bun:test";
import type {
	Agent,
	AgentLimit,
	PriorityRule,
	Settings,
} from "./_stubs/types.ts";
import { type RunSeherDeps, runSeher } from "./main.ts";

function mkAgent(command: string, provider?: string): Agent {
	return { command, provider, config: { command, provider } };
}

interface DepsBuildInput {
	settings?: Settings;
	parsed?: Partial<ReturnType<RunSeherDeps["parseArgs"]>>;
	checkLimit?: RunSeherDeps["checkLimit"];
	runAgent?: RunSeherDeps["runAgent"];
	sleepUntil?: RunSeherDeps["sleepUntil"];
	startWebServer?: RunSeherDeps["startWebServer"];
	collectPrompt?: RunSeherDeps["collectPrompt"];
}

function buildDeps(input: DepsBuildInput = {}): {
	deps: RunSeherDeps;
	stdout: string[];
	stderr: string[];
} {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const parsed = {
		quiet: false,
		json: false,
		priority: false,
		guiConfig: false,
		trailing: [] as string[],
		...input.parsed,
	};
	const deps: RunSeherDeps = {
		parseArgs: mock(() => parsed),
		loadSettings: mock(
			async () => input.settings ?? { agents: [], priority: [] },
		),
		filterAgents: mock((agents: Agent[]) => agents),
		sortByPriority: mock((agents: Agent[]) => agents),
		checkLimit:
			input.checkLimit ?? mock(async () => ({ kind: "not_limited" as const })),
		collectPrompt: input.collectPrompt ?? mock(async () => null),
		runAgent: input.runAgent ?? mock(async () => ({ exitCode: 0 })),
		sleepUntil: input.sleepUntil ?? mock(async () => {}),
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
			{ command: "claude", priority: 100 },
			{ command: "codex", priority: 50 },
		];
		const { deps, stdout } = buildDeps({
			settings: { agents: [], priority },
			parsed: {
				priority: true,
				quiet: false,
				json: false,
				guiConfig: false,
				trailing: [],
			},
		});

		const code = await runSeher([], deps);
		expect(code).toBe(0);
		const joined = stdout.join("\n");
		expect(joined).toContain("Priority order:");
		expect(joined).toContain("command=claude");
		expect(joined).toContain("command=codex");
	});

	test("--json outputs JSON-formatted agent statuses", async () => {
		const agents = [mkAgent("claude", "anthropic"), mkAgent("codex", "openai")];
		const checkLimit = mock(async (_p: string | undefined) => ({
			kind: "not_limited" as const,
		})) as unknown as RunSeherDeps["checkLimit"];
		const { deps, stdout } = buildDeps({
			settings: { agents, priority: [] },
			parsed: {
				json: true,
				quiet: false,
				priority: false,
				guiConfig: false,
				trailing: [],
			},
			checkLimit,
		});

		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(stdout.length).toBe(1);
		const parsed = JSON.parse(stdout[0] as string);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);
		expect(parsed[0].command).toBe("claude");
		expect(parsed[1].command).toBe("codex");
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
		const callArgs = (runAgent.mock.calls as unknown as [Agent, unknown][])[0];
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
			parsed: {
				quiet: true,
				json: false,
				priority: false,
				guiConfig: false,
				trailing: [],
			},
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
			parsed: {
				quiet: true,
				json: false,
				priority: false,
				guiConfig: false,
				trailing: [],
			},
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
			parsed: {
				guiConfig: true,
				quiet: false,
				priority: false,
				json: false,
				trailing: [],
			},
			startWebServer,
		});
		const code = await runSeher([], deps);
		expect(code).toBe(0);
		expect(startWebServer).toHaveBeenCalledTimes(1);
	});

	test("returns 1 with stderr message when no agents are available after filter", async () => {
		const { deps, stderr } = buildDeps({
			settings: { agents: [], priority: [] },
		});
		const code = await runSeher([], deps);
		expect(code).toBe(1);
		expect(stderr.join("\n")).toContain("No agents match");
	});
});
