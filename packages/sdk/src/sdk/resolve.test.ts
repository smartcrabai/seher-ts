import { describe, expect, mock, test } from "bun:test";
import type {
	AgentConfig,
	AgentLimit,
	ProviderConfig,
	Settings,
} from "../types.ts";
import {
	AllAgentsLimitedError,
	NoMatchingAgentError,
	resolveAgent,
} from "./resolve.ts";

const INFERRED: ProviderConfig = { kind: "inferred" };
const NO_PROVIDER: ProviderConfig = { kind: "none" };

function mkAgent(
	command: string,
	overrides: Partial<AgentConfig> = {},
): AgentConfig {
	return {
		command,
		args: [],
		models: null,
		arg_maps: {},
		env: null,
		provider: INFERRED,
		pre_command: [],
		active: null,
		inactive: null,
		...overrides,
	};
}

function mkSettings(agents: AgentConfig[]): Settings {
	return { agents, priority: [] };
}

describe("resolveAgent", () => {
	test("returns the first not-limited agent from sortedAgents", async () => {
		const agents = [
			mkAgent("claude", { sdk: "claude" }),
			mkAgent("codex", { sdk: "codex" }),
		];
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({
			sortedAgents: agents,
			checkLimit,
		});
		expect(agent.command).toBe("claude");
	});

	test("falls back to next agent when first is limited", async () => {
		const agents = [
			mkAgent("claude", { sdk: "claude" }),
			mkAgent("codex", { sdk: "codex" }),
		];
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(async (provider: string): Promise<AgentLimit> => {
			if (provider === "claude") return { kind: "limited", resetTime: reset };
			return { kind: "not_limited" };
		});
		const agent = await resolveAgent({
			sortedAgents: agents,
			checkLimit,
		});
		expect(agent.command).toBe("codex");
	});

	test("sleeps and rescans when all agents limited (default behavior)", async () => {
		const agents = [mkAgent("claude", { sdk: "claude" })];
		const reset = new Date("2099-01-01T00:00:00Z");
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			return calls === 1
				? { kind: "limited", resetTime: reset }
				: { kind: "not_limited" };
		});
		const sleepUntil = mock(async () => {});
		const agent = await resolveAgent({
			sortedAgents: agents,
			checkLimit,
			sleepUntil,
			quiet: true,
		});
		expect(agent.command).toBe("claude");
		expect(sleepUntil).toHaveBeenCalledTimes(1);
		const calledWith = (
			sleepUntil.mock.calls as unknown as [Date, unknown][]
		)[0];
		expect(calledWith?.[0]?.getTime()).toBe(reset.getTime());
	});

	test("throws AllAgentsLimitedError after maxRescans", async () => {
		const agents = [mkAgent("claude", { sdk: "claude" })];
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime: reset }),
		);
		const sleepUntil = mock(async () => {});
		await expect(
			resolveAgent({
				sortedAgents: agents,
				checkLimit,
				sleepUntil,
				quiet: true,
			}),
		).rejects.toBeInstanceOf(AllAgentsLimitedError);
	});

	test("noWait: true throws immediately without sleeping", async () => {
		const agents = [mkAgent("claude", { sdk: "claude" })];
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime: reset }),
		);
		const sleepUntil = mock(async () => {});
		await expect(
			resolveAgent({
				sortedAgents: agents,
				checkLimit,
				sleepUntil,
				noWait: true,
			}),
		).rejects.toBeInstanceOf(AllAgentsLimitedError);
		expect(sleepUntil).toHaveBeenCalledTimes(0);
	});

	test("provider.kind=none agents skip checkLimit", async () => {
		const agents = [
			mkAgent("fallback", { sdk: "claude", provider: NO_PROVIDER }),
		];
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({
			sortedAgents: agents,
			checkLimit,
		});
		expect(agent.command).toBe("fallback");
		expect(checkLimit).toHaveBeenCalledTimes(0);
	});

	test("throws NoMatchingAgentError on empty sortedAgents", async () => {
		await expect(
			resolveAgent({
				sortedAgents: [],
			}),
		).rejects.toBeInstanceOf(NoMatchingAgentError);
	});

	test("loads settings and applies command filter when sortedAgents not provided", async () => {
		const agents = [
			mkAgent("claude", { sdk: "claude" }),
			mkAgent("codex", { sdk: "codex" }),
		];
		const settings = mkSettings(agents);
		const loadSettings = mock(async () => settings);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({
			command: "codex",
			loadSettings,
			checkLimit,
		});
		expect(agent.command).toBe("codex");
		expect(loadSettings).toHaveBeenCalledTimes(1);
	});

	test("AllAgentsLimitedError carries the earliest reset time", async () => {
		const agents = [
			mkAgent("claude", { sdk: "claude" }),
			mkAgent("codex", { sdk: "codex" }),
		];
		const earlier = new Date("2099-01-01T00:00:00Z");
		const later = new Date("2099-01-01T01:00:00Z");
		const checkLimit = mock(async (provider: string): Promise<AgentLimit> => {
			return {
				kind: "limited",
				resetTime: provider === "claude" ? later : earlier,
			};
		});
		try {
			await resolveAgent({
				sortedAgents: agents,
				checkLimit,
				noWait: true,
			});
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(AllAgentsLimitedError);
			expect((err as AllAgentsLimitedError).minReset.getTime()).toBe(
				earlier.getTime(),
			);
		}
	});

	test("provider filter selects the matching agent when sortedAgents not provided", async () => {
		const agents = [
			mkAgent("claude", {
				sdk: "claude",
				provider: { kind: "explicit", name: "anthropic" },
			}),
			mkAgent("claude-router", {
				sdk: "claude",
				provider: { kind: "explicit", name: "openrouter" },
			}),
		];
		const settings: Settings = { agents, priority: [] };
		const loadSettings = mock(async () => settings);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({
			provider: "openrouter",
			loadSettings,
			checkLimit,
		});
		expect(agent.command).toBe("claude-router");
	});

	test("model filter excludes agents whose models map lacks the requested key", async () => {
		const agents = [
			mkAgent("claude", {
				sdk: "claude",
				models: { sonnet: "claude-sonnet-4-6" },
			}),
			mkAgent("codex", { sdk: "codex", models: { mini: "gpt-5-codex-mini" } }),
		];
		const settings: Settings = { agents, priority: [] };
		const loadSettings = mock(async () => settings);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({
			model: "mini",
			loadSettings,
			checkLimit,
		});
		expect(agent.command).toBe("codex");
	});

	test("invokes onSleep callback before sleeping", async () => {
		const agents = [mkAgent("claude", { sdk: "claude" })];
		const reset = new Date("2099-01-01T00:00:00Z");
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			return calls === 1
				? { kind: "limited", resetTime: reset }
				: { kind: "not_limited" };
		});
		const sleepUntil = mock(async () => {});
		const onSleep = mock(() => {});
		await resolveAgent({
			sortedAgents: agents,
			checkLimit,
			sleepUntil,
			onSleep,
			quiet: true,
		});
		expect(onSleep).toHaveBeenCalledTimes(1);
		const onSleepArgs = (onSleep.mock.calls as unknown as [Date][])[0];
		expect(onSleepArgs?.[0]?.getTime()).toBe(reset.getTime());
	});
});
