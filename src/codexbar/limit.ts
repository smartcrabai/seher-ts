import type { AgentLimit } from "./agentLimit.ts";
import { type RunCodexBarUsageOptions, runCodexBarUsage } from "./client.ts";
import type { CodexBarUsageResponse, CodexBarWindow } from "./types.ts";

export type RunCodexBarUsageFn = (
	provider: string,
	opts?: RunCodexBarUsageOptions,
) => Promise<CodexBarUsageResponse>;

export interface CheckLimitOptions extends RunCodexBarUsageOptions {
	runUsage?: RunCodexBarUsageFn;
}

const FALLBACK_RESET_MS = 5 * 60 * 1000;

function parseResetsAt(resetsAt: string | undefined): Date {
	if (resetsAt) {
		const parsed = new Date(resetsAt);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed;
		}
	}
	return new Date(Date.now() + FALLBACK_RESET_MS);
}

function isLimited(window: CodexBarWindow): boolean {
	return window.usedPercent >= 100;
}

export async function checkLimit(
	provider: string,
	opts: CheckLimitOptions = {},
): Promise<AgentLimit> {
	const { runUsage = runCodexBarUsage, ...runOpts } = opts;
	const response = await runUsage(provider, runOpts);

	const windows: CodexBarWindow[] = [];
	if (response.usage.primary) {
		windows.push(response.usage.primary);
	}
	if (response.usage.secondary) {
		windows.push(response.usage.secondary);
	}

	const limitedResetTimes = windows
		.filter(isLimited)
		.map((w) => parseResetsAt(w.resetsAt).getTime());

	if (limitedResetTimes.length === 0) {
		return { kind: "not_limited" };
	}

	// Pick the earliest reset so the agent waits the minimum amount of time.
	return {
		kind: "limited",
		resetTime: new Date(Math.min(...limitedResetTimes)),
	};
}
