import type { SeherSDKOptions } from "@seher-ts/sdk";
import type { Logger } from "./logger.ts";

/**
 * Wire the retry-on-limit callbacks on a `SeherSDKOptions` to a `Logger`.
 * Used by both `runBuildMode` and `runPlanMode` (which constructs its own SDK).
 */
export function applyRetryHooks(
	opts: SeherSDKOptions,
	logger: Logger,
): SeherSDKOptions {
	opts.retryOnLimit = true;
	opts.onLimitRetry = (info) => {
		const reset =
			info.resetAt !== undefined
				? ` (resets at ${info.resetAt.toISOString()})`
				: "";
		logger.warn(
			`Provider '${info.provider}' hit API limit${reset}; retrying with next available provider...`,
		);
	};
	opts.onAllLimited = () => {
		logger.warn(
			"All providers are limited; polling CodexBar every 60s. Press Ctrl-C to abort.",
		);
	};
	// Attempt 1 fires right after onAllLimited's warning, so skip it. Then log
	// every 10th attempt so a long limit window doesn't fill stderr.
	opts.onLimitWaitTick = (attempt) => {
		if (attempt === 1 || attempt % 10 !== 0) return;
		logger.info(`Still limited (attempt ${attempt})...`);
	};
	// Emit a warn in the same format as the Rust CLI right before retrying
	// a transient HTTP error (e.g. `HTTP 429/5xx`) on the same provider.
	opts.onTransientRetry = (info) => {
		const delaySecs = Math.max(0, Math.round(info.delayMs / 1000));
		logger.warn(
			`Provider '${info.provider}' returned a transient API error (attempt ${info.attempt}/${info.maxAttempts}): ${info.message}; retrying in ${delaySecs}s...`,
		);
	};
	return opts;
}
