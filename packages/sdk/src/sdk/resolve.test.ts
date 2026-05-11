import { describe, expect, mock, test } from "bun:test";
import { CodexBarError, CodexBarNotFoundError } from "../codexbar/errors.ts";
import type { AgentLimit } from "../types.ts";
import { mkConfig } from "./__test__/mkConfig.ts";
import {
	AllAgentsLimitedError,
	NoMatchingAgentError,
	pollForAgent,
	resolveAgent,
} from "./resolve.ts";

describe("resolveAgent", () => {
	test("returns the highest-priority candidate that defines models[modeKey]", async () => {
		const config = mkConfig(
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
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({ config, checkLimit });
		expect(agent.provider).toBe("codex");
		expect(agent.modelId).toBe("gpt-5.5");
		expect(agent.modeKey).toBe("build");
	});

	test("model-level priority overrides provider-level", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				priority: 1,
				models: { build: { model: "sonnet", priority: 9 } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				priority: 5,
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({ config, checkLimit });
		expect(agent.provider).toBe("claude");
	});

	test("excludes providers that do not define the requested mode", async () => {
		const config = mkConfig(
			{
				key: "codex",
				order: 0,
				sdk: "codex",
				priority: 5,
				models: { build: { model: "x" } },
			},
			{
				key: "claude",
				order: 1,
				sdk: "claude",
				priority: 3,
				models: { plan: { model: "opus" }, build: { model: "sonnet" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({ config, modeKey: "plan", checkLimit });
		expect(agent.provider).toBe("claude");
		expect(agent.modelId).toBe("opus");
	});

	test("falls back to next candidate when first is limited", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				priority: 3,
				models: { build: { model: "sonnet" } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				priority: 2,
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(async (provider: string): Promise<AgentLimit> => {
			if (provider === "claude") return { kind: "limited", resetTime: reset };
			return { kind: "not_limited" };
		});
		const agent = await resolveAgent({ config, checkLimit });
		expect(agent.provider).toBe("codex");
	});

	test("CodexBarError is treated as not_limited", async () => {
		const config = mkConfig({
			key: "zai",
			order: 0,
			sdk: "claude",
			models: { build: { model: "glm-5.1" } },
		});
		const checkLimit = mock(async () => {
			throw new CodexBarError("missing entry", 0, "");
		});
		const agent = await resolveAgent({ config, checkLimit });
		expect(agent.provider).toBe("zai");
	});

	test("CodexBarNotFoundError is treated as not_limited", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const checkLimit = mock(async () => {
			throw new CodexBarNotFoundError("no binary");
		});
		const agent = await resolveAgent({ config, checkLimit });
		expect(agent.provider).toBe("claude");
	});

	test("noWait throws AllAgentsLimitedError without sleeping", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime: reset }),
		);
		const sleepUntil = mock(async () => {});
		await expect(
			resolveAgent({ config, checkLimit, sleepUntil, noWait: true }),
		).rejects.toBeInstanceOf(AllAgentsLimitedError);
		expect(sleepUntil).toHaveBeenCalledTimes(0);
	});

	test("sleeps and rescans by default", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
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
			config,
			checkLimit,
			sleepUntil,
			quiet: true,
		});
		expect(agent.provider).toBe("claude");
		expect(sleepUntil).toHaveBeenCalledTimes(1);
	});

	test("provider filter restricts candidate set", async () => {
		const config = mkConfig(
			{
				key: "codex",
				order: 0,
				sdk: "codex",
				priority: 9,
				models: { build: { model: "x" } },
			},
			{
				key: "claude",
				order: 1,
				sdk: "claude",
				models: { build: { model: "sonnet" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({
			config,
			provider: "claude",
			checkLimit,
		});
		expect(agent.provider).toBe("claude");
	});

	test("throws NoMatchingAgentError when no provider defines the mode", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		await expect(
			resolveAgent({ config, modeKey: "plan" }),
		).rejects.toBeInstanceOf(NoMatchingAgentError);
	});

	test("forwards api into ResolvedAgent", async () => {
		const config = mkConfig({
			key: "zai",
			order: 0,
			sdk: "claude",
			api: { key: "sk-za", endpoint: "https://zai.test" },
			models: { build: { model: "glm-5.1" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({ config, checkLimit });
		expect(agent.api).toEqual({ key: "sk-za", endpoint: "https://zai.test" });
	});

	test("excludeProviders filters candidates", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				priority: 5,
				models: { build: { model: "sonnet" } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				priority: 3,
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await resolveAgent({
			config,
			checkLimit,
			excludeProviders: ["claude"],
		});
		expect(agent.provider).toBe("codex");
	});

	test("invokes onSleep callback before sleeping", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
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
			config,
			checkLimit,
			sleepUntil,
			onSleep,
			quiet: true,
		});
		expect(onSleep).toHaveBeenCalledTimes(1);
	});
});

describe("pollForAgent", () => {
	test("returns immediately when a candidate is not_limited", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const onTick = mock(() => {});
		const agent = await pollForAgent({
			config,
			checkLimit,
			onTick,
			intervalMs: 50,
		});
		expect(agent.provider).toBe("claude");
		expect(onTick).toHaveBeenCalledTimes(1);
	});

	test("polls intervalMs until a candidate recovers", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const reset = new Date("2099-01-01T00:00:00Z");
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			if (calls < 3) return { kind: "limited", resetTime: reset };
			return { kind: "not_limited" };
		});
		const ticks: number[] = [];
		const onTick = mock((n: number) => {
			ticks.push(n);
		});
		const agent = await pollForAgent({
			config,
			checkLimit,
			onTick,
			intervalMs: 10,
		});
		expect(agent.provider).toBe("claude");
		expect(calls).toBe(3);
		expect(ticks).toEqual([1, 2, 3]);
	});

	test("rejects with AbortError when signal aborts", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime: reset }),
		);
		const ac = new AbortController();
		const p = pollForAgent({
			config,
			checkLimit,
			intervalMs: 1000,
			signal: ac.signal,
		});
		queueMicrotask(() => ac.abort());
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
	});

	test("respects excludeProviders", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				priority: 5,
				models: { build: { model: "sonnet" } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const agent = await pollForAgent({
			config,
			checkLimit,
			excludeProviders: ["claude"],
		});
		expect(agent.provider).toBe("codex");
	});

	test("throws NoMatchingAgentError when all candidates errored without reset", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const checkLimit = mock(async () => {
			throw new Error("non-codexbar transient");
		});
		await expect(
			pollForAgent({ config, checkLimit, intervalMs: 10 }),
		).rejects.toBeInstanceOf(NoMatchingAgentError);
	});
});
