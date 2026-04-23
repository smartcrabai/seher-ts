import { describe, expect, test } from "bun:test";
import { checkLimit } from "./limit.ts";
import type { CodexBarUsageResponse, CodexBarWindow } from "./types.ts";

function makeWindow(
	usedPercent: number,
	resetsAt: string,
	windowMinutes = 60,
): CodexBarWindow {
	return { usedPercent, windowMinutes, resetsAt };
}

function makeResponse(
	primary?: CodexBarWindow,
	secondary?: CodexBarWindow,
): CodexBarUsageResponse {
	return {
		provider: "codex",
		usage: {
			...(primary ? { primary } : {}),
			...(secondary ? { secondary } : {}),
		},
	};
}

describe("checkLimit", () => {
	test("returns not_limited when both windows are under 100%", async () => {
		const now = Date.now();
		const response = makeResponse(
			makeWindow(50, new Date(now + 60 * 60 * 1000).toISOString()),
			makeWindow(30, new Date(now + 2 * 60 * 60 * 1000).toISOString()),
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result).toEqual({ kind: "not_limited" });
	});

	test("returns limited with primary resetTime when only primary is 100%", async () => {
		const now = Date.now();
		const resetAt = new Date(now + 60 * 60 * 1000);
		const response = makeResponse(
			makeWindow(100, resetAt.toISOString()),
			makeWindow(40, new Date(now + 2 * 60 * 60 * 1000).toISOString()),
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			expect(result.resetTime.getTime()).toBe(resetAt.getTime());
		}
	});

	test("picks the earliest resetsAt when multiple windows are limited", async () => {
		const now = Date.now();
		const primaryReset = new Date(now + 60 * 60 * 1000);
		const secondaryReset = new Date(now + 30 * 60 * 1000);
		const response = makeResponse(
			makeWindow(100, primaryReset.toISOString()),
			makeWindow(100, secondaryReset.toISOString()),
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			expect(result.resetTime.getTime()).toBe(secondaryReset.getTime());
		}
	});

	test("treats 99.9% as not limited", async () => {
		const response = makeResponse(
			makeWindow(99.9, new Date(Date.now() + 60 * 60 * 1000).toISOString()),
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result).toEqual({ kind: "not_limited" });
	});

	test("falls back to +5min when resetsAt is unparseable", async () => {
		const response = makeResponse(makeWindow(100, "not-a-date"));
		const before = Date.now();
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		const after = Date.now();
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			const ts = result.resetTime.getTime();
			expect(ts).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);
			expect(ts).toBeLessThanOrEqual(after + 5 * 60 * 1000 + 50);
		}
	});

	test("returns not_limited when usage has no windows", async () => {
		const response: CodexBarUsageResponse = {
			provider: "codex",
			usage: {},
		};
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result).toEqual({ kind: "not_limited" });
	});

	test("forwards options to runUsage", async () => {
		let seenProvider = "";
		let seenOpts: Record<string, unknown> | undefined;
		const response: CodexBarUsageResponse = {
			provider: "codex",
			usage: {},
		};
		await checkLimit("codex", {
			accountLabel: "work",
			accountIndex: 2,
			binPath: "/tmp/codexbar",
			timeoutMs: 1234,
			runUsage: async (provider, opts) => {
				seenProvider = provider;
				seenOpts = opts as Record<string, unknown>;
				return response;
			},
		});
		expect(seenProvider).toBe("codex");
		expect(seenOpts).toEqual({
			accountLabel: "work",
			accountIndex: 2,
			binPath: "/tmp/codexbar",
			timeoutMs: 1234,
		});
	});
});
