import type { SdkKind } from "../types.ts";

/**
 * Detect whether a Claude error message contains a rate-limit / quota
 * phrase. Shared by the `claude` / `claude-terminal` / `claude-headless`
 * SDKs when classifying failures by string matching. Kept as a single
 * helper so a newly observed phrase only needs to be added in one place.
 */
export function isClaudeRateLimitMessage(msg: string): boolean {
	const lower = msg.toLowerCase();
	return (
		lower.includes("rate limit") ||
		lower.includes("usage limit") ||
		lower.includes("too many requests") ||
		lower.includes("session limit")
	);
}

/**
 * Thrown by a provider wrapper when it detects an API rate-limit / quota
 * signal during `run()` or `stream()`. The retry orchestration in
 * `SeherSDK` catches this and falls over to the next non-limited provider
 * (when `retryOnLimit` is enabled).
 */
export interface LimitErrorOptions {
	provider?: string;
	resetAt?: Date;
	cause?: unknown;
	message?: string;
}

export class LimitError extends Error {
	readonly kind: SdkKind;
	readonly provider?: string;
	readonly resetAt?: Date;

	constructor(kind: SdkKind, opts: LimitErrorOptions = {}) {
		const message =
			opts.message ?? `Provider '${opts.provider ?? kind}' hit API limit`;
		super(
			message,
			opts.cause !== undefined ? { cause: opts.cause } : undefined,
		);
		this.name = "LimitError";
		this.kind = kind;
		if (opts.provider !== undefined) this.provider = opts.provider;
		if (opts.resetAt !== undefined) this.resetAt = opts.resetAt;
	}
}

/**
 * If `predicate(err)` matches, throw a `LimitError` wrapping `err`.
 * Otherwise re-throw `err` unchanged. Convenience for provider wrappers.
 */
export function rethrowAsLimit(
	kind: SdkKind,
	err: unknown,
	predicate: (err: unknown) => boolean,
): never {
	if (predicate(err)) {
		const opts: LimitErrorOptions = { provider: kind, cause: err };
		if (err instanceof Error) opts.message = err.message;
		throw new LimitError(kind, opts);
	}
	throw err;
}

// Session ids get passed as (1) a file name and (2) a child-process argument,
// so we defend at the SDK layer too, not just via CLI-layer validation. If a
// library consumer calls SeherSDK directly (bypassing the CLI) with a value
// like `../../etc/passwd` or `--dangerous-flag`, this rejects it here before
// it reaches `run()` / `stream()`.
const SDK_RESUME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SDK_RESUME_MAX_LEN = 128;

/**
 * Validate a session resume id at the SDK boundary.
 *
 * - Rejects empty / >128 chars (length DoS guard).
 * - Rejects path separators / shell metacharacters (path traversal).
 * - Rejects ids that start with `-` (would be misread as a CLI flag when
 *   forwarded to `claude --resume <id>` etc.).
 *
 * Throws `TypeError` on rejection so callers can distinguish argument errors
 * from runtime failures.
 */
export function assertValidResumeId(id: string): void {
	if (id.length === 0 || id.length > SDK_RESUME_MAX_LEN) {
		throw new TypeError(
			`Invalid resume id: expected 1..${SDK_RESUME_MAX_LEN} chars, got ${id.length}`,
		);
	}
	if (!SDK_RESUME_PATTERN.test(id)) {
		throw new TypeError(
			`Invalid resume id '${id}': expected alphanumeric, '-', '_'`,
		);
	}
	if (id.startsWith("-")) {
		throw new TypeError(
			`Invalid resume id '${id}': must not start with '-' (would be parsed as a CLI flag)`,
		);
	}
}
