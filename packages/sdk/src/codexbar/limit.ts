import type { AgentLimit, SdkKind } from "../types.ts";
import { type RunCodexBarUsageOptions, runCodexBarUsage } from "./client.ts";
import type { CodexBarUsageResponse, CodexBarWindow } from "./types.ts";

/**
 * Some SDK kinds share their codexbar account with a different provider name —
 * `claude-terminal` / `claude-headless` invoke the Claude CLI which
 * authenticates as `claude`, so they normally share that account's codexbar
 * quota.
 *
 * However, an entry may override `ANTHROPIC_BASE_URL` in its resolved `env`
 * to point the `claude` CLI at a third-party Anthropic-compatible endpoint
 * (e.g. kimi, zai); in that case the CLI's `claude` login usage is
 * irrelevant, so `codexbarProviderName` queries codexbar under the entry's
 * own provider name instead (see its `env` handling below).
 */
const CODEXBAR_PROVIDER_ALIAS: Partial<Record<SdkKind, string>> = {
	"claude-terminal": "claude",
	"claude-headless": "claude",
};

/**
 * Resolves the codexbar provider name to query for `sdkKind`/`provider`.
 *
 * `claude-terminal` / `claude-headless` alias to the shared `claude` account
 * (see `CODEXBAR_PROVIDER_ALIAS`) *unless* `env.ANTHROPIC_BASE_URL` is set to
 * a non-empty (post-trim) value, in which case the entry is talking to a
 * third-party endpoint through the `claude` CLI and must be probed under its
 * own `provider` name instead. A blank (empty or whitespace-only) override is
 * not treated as an override, matching the Rust side's semantics.
 */
export function codexbarProviderName(
	sdkKind: SdkKind,
	provider: string,
	env: Record<string, string>,
): string {
	const alias = CODEXBAR_PROVIDER_ALIAS[sdkKind];
	if (alias === undefined) return provider;
	const baseUrlOverride = env.ANTHROPIC_BASE_URL;
	if (baseUrlOverride !== undefined && baseUrlOverride.trim() !== "") {
		return provider;
	}
	return alias;
}

export type RunCodexBarUsageFn = (
	provider: string,
	opts?: RunCodexBarUsageOptions,
) => Promise<CodexBarUsageResponse>;

export interface CheckLimitOptions extends RunCodexBarUsageOptions {
	runUsage?: RunCodexBarUsageFn;
	/** Override for tests; defaults to `() => new Date()`. */
	now?: () => Date;
}

const FALLBACK_RESET_MS = 5 * 60 * 1000;

function parseResetsAt(resetsAt: string | null | undefined, now: Date): Date {
	if (resetsAt) {
		const parsed = new Date(resetsAt);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed;
		}
	}
	return new Date(now.getTime() + FALLBACK_RESET_MS);
}

function isLimited(window: CodexBarWindow): boolean {
	return window.usedPercent >= 100;
}

export async function checkLimit(
	provider: string,
	opts: CheckLimitOptions = {},
): Promise<AgentLimit> {
	const {
		runUsage = runCodexBarUsage,
		now = () => new Date(),
		...runOpts
	} = opts;
	const response = await runUsage(provider, runOpts);

	const windows: CodexBarWindow[] = [];
	if (response.usage.primary) {
		windows.push(response.usage.primary);
	}
	if (response.usage.secondary) {
		windows.push(response.usage.secondary);
	}
	if (response.usage.tertiary) {
		windows.push(response.usage.tertiary);
	}
	if (response.usage.extraRateWindows) {
		for (const named of response.usage.extraRateWindows) {
			windows.push(named.window);
		}
	}

	const nowDate = now();
	const nowMs = nowDate.getTime();
	const limitedResetTimes = windows
		.filter(isLimited)
		.map((w) => parseResetsAt(w.resetsAt, nowDate).getTime())
		// A window whose resetsAt has already passed is a stale snapshot (it
		// has presumably already reset server-side), not an active limit, so
		// it is excluded here. Windows with no parseable resetsAt fall back to
		// `now + 5m` (see `parseResetsAt`), which is always in the future, so
		// this filter never drops the no-resetsAt fallback case.
		.filter((t) => t > nowMs);

	if (limitedResetTimes.length === 0) {
		return { kind: "not_limited" };
	}

	// Pick the earliest reset so the agent waits the minimum amount of time.
	return {
		kind: "limited",
		resetTime: new Date(Math.min(...limitedResetTimes)),
	};
}
