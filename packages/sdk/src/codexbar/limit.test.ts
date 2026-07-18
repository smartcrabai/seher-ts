import { describe, expect, test } from "bun:test";
import { checkLimit, codexbarProviderName } from "./limit.ts";
import type {
	CodexBarUsageResponse,
	CodexBarWindow,
	NamedCodexBarWindow,
} from "./types.ts";

function makeWindow(
	usedPercent: number,
	resetsAt: string,
	windowMinutes = 60,
): CodexBarWindow {
	return { usedPercent, windowMinutes, resetsAt };
}

function makeResponse(
	primary?: CodexBarWindow | null,
	secondary?: CodexBarWindow | null,
	tertiary?: CodexBarWindow | null,
	extraRateWindows?: NamedCodexBarWindow[],
): CodexBarUsageResponse {
	return {
		provider: "codex",
		usage: {
			...(primary !== undefined ? { primary } : {}),
			...(secondary !== undefined ? { secondary } : {}),
			...(tertiary !== undefined ? { tertiary } : {}),
			...(extraRateWindows ? { extraRateWindows } : {}),
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

	test("not_limited when the only 100% window's resetsAt has already passed", async () => {
		// A window at 100% whose resetsAt is in the past is a stale snapshot
		// (it has presumably already reset server-side), not an active limit.
		// Mirrors the Rust `not_limited_when_resets_at_already_passed` test.
		const now = new Date("2026-01-01T00:00:00Z");
		const response = makeResponse(
			makeWindow(100, "2025-01-01T00:00:00Z"),
			makeWindow(10, new Date(now.getTime() + 60 * 60 * 1000).toISOString()),
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
			now: () => now,
		});
		expect(result).toEqual({ kind: "not_limited" });
	});

	test("ignores a stale (past resetsAt) window but limits on a future one", async () => {
		// One window is 100% with a past resetsAt (stale, ignored) and the
		// other is 100% with a future resetsAt (still active) -- the result
		// should use the future window's reset time. Mirrors the Rust
		// `ignores_stale_reset_but_limits_on_future_reset` test.
		const now = new Date("2026-01-01T00:00:00Z");
		const response = makeResponse(
			makeWindow(100, "2025-01-01T00:00:00Z"),
			makeWindow(100, "2099-01-01T00:00:00Z"),
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
			now: () => now,
		});
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			expect(result.resetTime.getTime()).toBe(
				new Date("2099-01-01T00:00:00Z").getTime(),
			);
		}
	});

	test("resetsAt-less fallback still counts as limited (always in the future)", async () => {
		// A limited window with no parseable resetsAt falls back to `now +
		// 5m`, which the stale-window filter must never drop.
		const now = new Date("2026-01-01T00:00:00Z");
		const response = makeResponse(makeWindow(100, "not-a-date"));
		const result = await checkLimit("codex", {
			runUsage: async () => response,
			now: () => now,
		});
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			expect(result.resetTime.getTime()).toBe(now.getTime() + 5 * 60 * 1000);
		}
	});

	test("returns limited when tertiary window is 100%", async () => {
		const now = Date.now();
		const tertiaryReset = new Date(now + 45 * 60 * 1000);
		const response = makeResponse(
			makeWindow(40, new Date(now + 60 * 60 * 1000).toISOString()),
			makeWindow(60, new Date(now + 2 * 60 * 60 * 1000).toISOString()),
			makeWindow(100, tertiaryReset.toISOString()),
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			expect(result.resetTime.getTime()).toBe(tertiaryReset.getTime());
		}
	});

	test("returns limited when an extraRateWindows entry is 100%", async () => {
		const now = Date.now();
		const extraReset = new Date(now + 20 * 60 * 1000);
		const response = makeResponse(
			makeWindow(40, new Date(now + 60 * 60 * 1000).toISOString()),
			null,
			null,
			[
				{
					id: "claude-design",
					title: "Designs",
					window: makeWindow(100, extraReset.toISOString()),
				},
			],
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			expect(result.resetTime.getTime()).toBe(extraReset.getTime());
		}
	});

	test("picks the earliest reset across all window slots", async () => {
		const now = Date.now();
		const primaryReset = new Date(now + 60 * 60 * 1000);
		const secondaryReset = new Date(now + 50 * 60 * 1000);
		const tertiaryReset = new Date(now + 40 * 60 * 1000);
		const extraReset = new Date(now + 30 * 60 * 1000);
		const response = makeResponse(
			makeWindow(100, primaryReset.toISOString()),
			makeWindow(100, secondaryReset.toISOString()),
			makeWindow(100, tertiaryReset.toISOString()),
			[
				{
					id: "claude-routines",
					title: "Routines",
					window: makeWindow(100, extraReset.toISOString()),
				},
			],
		);
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result.kind).toBe("limited");
		if (result.kind === "limited") {
			expect(result.resetTime.getTime()).toBe(extraReset.getTime());
		}
	});

	test("ignores null primary/secondary/tertiary", async () => {
		const response: CodexBarUsageResponse = {
			provider: "codex",
			usage: { primary: null, secondary: null, tertiary: null },
		};
		const result = await checkLimit("codex", {
			runUsage: async () => response,
		});
		expect(result).toEqual({ kind: "not_limited" });
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

	test("codexbarProviderName maps claude-terminal to claude", () => {
		expect(codexbarProviderName("claude-terminal", "claude-terminal", {})).toBe(
			"claude",
		);
		expect(codexbarProviderName("claude-terminal", "my-claude", {})).toBe(
			"claude",
		);
	});

	test("codexbarProviderName maps claude-headless to claude", () => {
		expect(codexbarProviderName("claude-headless", "claude-headless", {})).toBe(
			"claude",
		);
	});

	test("codexbarProviderName returns the provider name unchanged for other kinds", () => {
		expect(codexbarProviderName("claude", "claude", {})).toBe("claude");
		expect(codexbarProviderName("codex", "codex", {})).toBe("codex");
		expect(codexbarProviderName("opencode", "opencodego", {})).toBe(
			"opencodego",
		);
	});

	test("codexbarProviderName uses the entry's own provider name when ANTHROPIC_BASE_URL is overridden", () => {
		// A claude-family sdk with a non-empty ANTHROPIC_BASE_URL override is
		// actually talking to a third-party Anthropic-compatible endpoint (e.g.
		// kimi, zai), so the claude CLI's own account usage is irrelevant --
		// codexbar should be queried under the entry's own provider name
		// instead (mirrors the Rust `codexbar_provider_name` fix).
		const env = { ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/" };
		expect(codexbarProviderName("claude-terminal", "kimi", env)).toBe("kimi");
		expect(codexbarProviderName("claude-headless", "kimi", env)).toBe("kimi");
	});

	test("codexbarProviderName ignores a blank ANTHROPIC_BASE_URL override", () => {
		// Empty or whitespace-only overrides are not real overrides, so
		// claude-family sdks still alias to the shared `claude` account.
		expect(
			codexbarProviderName("claude-terminal", "kimi", {
				ANTHROPIC_BASE_URL: "",
			}),
		).toBe("claude");
		expect(
			codexbarProviderName("claude-headless", "kimi", {
				ANTHROPIC_BASE_URL: "   ",
			}),
		).toBe("claude");
	});

	test("codexbarProviderName ignores unrelated env keys", () => {
		// No ANTHROPIC_BASE_URL present -- claude-family sdks still alias to
		// the shared `claude` account regardless of other env vars.
		expect(
			codexbarProviderName("claude-terminal", "kimi", {
				ANTHROPIC_API_KEY: "sk-something",
			}),
		).toBe("claude");
	});

	test("codexbarProviderName ignores ANTHROPIC_BASE_URL for non-claude-family sdks", () => {
		const env = { ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/" };
		expect(codexbarProviderName("pi", "kimi", env)).toBe("kimi");
		expect(codexbarProviderName("codex", "codex", env)).toBe("codex");
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
