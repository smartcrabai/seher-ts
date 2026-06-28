import type { SdkKind } from "../types.ts";

/**
 * Claude のエラーメッセージにレート制限 / クォータ系のフレーズが含まれているか判定する。
 * `claude` / `claude-terminal` / `claude-headless` の各 SDK で文字列ベースに
 * 失敗を分類する際に共有する。新しいフレーズが現れたときに 1 箇所で更新できるよう、
 * 共通ヘルパーにまとめてある。
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
