/**
 * Exponential backoff retry helpers for transient provider API errors.
 *
 * Ported from the Rust implementation (`seher::sdk::config::RetryConfig`
 * and `seher::sdk::errors`) to TypeScript. Used by both the SDK's
 * internal `seherSdk.ts` and the CLI's retry hook.
 */

import type { ResolvedRetryConfig } from "../types.ts";

/**
 * Checks that the string contains `HTTP <status>` and that the character
 * right after it is not a digit (i.e. end of string or a non-digit).
 *
 * This guards against false positives like `HTTP 5002` and is equivalent
 * to `contains_http_status` on the Rust side. Exported so provider-specific
 * limit classifiers (`pi.ts`, `codex.ts`, `kimi.ts`) can require this same
 * `"HTTP 429"` context instead of matching a bare `"429"` token, which would
 * false-positive on any coincidental "429" substring (a request id, a byte
 * count, ...) in an error message.
 */
export function containsHttpStatus(message: string, status: number): boolean {
	const needle = `HTTP ${status}`;
	let from = 0;
	while (true) {
		const idx = message.indexOf(needle, from);
		if (idx < 0) return false;
		const next = message.charAt(idx + needle.length);
		// Match only if we're at the end of the string, or the next
		// character is not an ASCII digit.
		if (next === "" || next < "0" || next > "9") return true;
		from = idx + needle.length;
	}
}

/**
 * Determines whether this is a transient HTTP error that should always be
 * retried.
 *
 * Supported statuses: 429 / 500 / 502 / 503 / 504. Only full status codes
 * are matched to avoid false positives like `HTTP 5002`.
 */
export function isTransientHttpError(message: string): boolean {
	return (
		containsHttpStatus(message, 429) ||
		containsHttpStatus(message, 500) ||
		containsHttpStatus(message, 502) ||
		containsHttpStatus(message, 503) ||
		containsHttpStatus(message, 504)
	);
}

/**
 * Determines whether this is an HTTP client error that should only be
 * retried when explicitly opted in.
 *
 * Some providers (e.g. Kimi) transiently return 401/404, but these
 * normally indicate an auth/routing failure, so we only retry them when
 * `retryClientErrors` is true.
 */
export function isClientErrorRetryable(message: string): boolean {
	return containsHttpStatus(message, 401) || containsHttpStatus(message, 404);
}

/**
 * Determines whether `message` is retryable under this retry policy.
 */
export function isRetryableMessage(
	message: string,
	retry: ResolvedRetryConfig,
): boolean {
	return (
		isTransientHttpError(message) ||
		(retry.retryClientErrors && isClientErrorRetryable(message))
	);
}

/**
 * Returns a safe value (minimum 1) even if a user bypasses validation and
 * sets `maxAttempts: 0`.
 */
export function effectiveMaxAttempts(retry: ResolvedRetryConfig): number {
	return Math.max(1, retry.maxAttempts);
}

/**
 * Clamps to 1.0 because a `multiplier < 1` would cause the delay to decay.
 */
export function effectiveMultiplier(retry: ResolvedRetryConfig): number {
	return Math.max(1.0, retry.multiplier);
}

/**
 * Computes the wait time in milliseconds for a 1-based attempt number.
 *
 * Returns `min(maxDelaySecs, initialDelaySecs * multiplier^(attempt-1))`,
 * floored to whole seconds and converted to milliseconds (matching the
 * same discretization as the Rust version).
 */
export function delayForAttempt(
	attempt: number,
	retry: ResolvedRetryConfig,
): number {
	const exponent = Math.max(0, attempt - 1);
	const raw = retry.initialDelaySecs * effectiveMultiplier(retry) ** exponent;
	const clampedSecs = Math.floor(Math.min(retry.maxDelaySecs, raw));
	return clampedSecs * 1000;
}
