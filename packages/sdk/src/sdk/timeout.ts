import type { SdkKind } from "../types.ts";

/**
 * Thrown when a provider exceeds its `timeoutMs`. Rejects the awaiting promise
 * but does NOT abort in-flight provider work — upstream SDKs without
 * cancellation plumbing may continue running in the background.
 */
export class TimeoutError extends Error {
	readonly kind: SdkKind;
	readonly timeoutMs: number;

	constructor(kind: SdkKind, timeoutMs: number, label: "run" | "stream") {
		super(`${kind} ${label} timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
		this.kind = kind;
		this.timeoutMs = timeoutMs;
	}
}

/** Pass-through when `timeoutMs` is undefined; otherwise reject after the deadline. */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number | undefined,
	kind: SdkKind,
): Promise<T> {
	if (timeoutMs === undefined) return promise;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new TimeoutError(kind, timeoutMs, "run"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Apply a total-elapsed deadline across all iterations of `source`. */
export function withStreamTimeout<T>(
	source: AsyncIterable<T>,
	timeoutMs: number | undefined,
	kind: SdkKind,
): AsyncIterable<T> {
	if (timeoutMs === undefined) return source;
	return {
		async *[Symbol.asyncIterator]() {
			const deadline = Date.now() + timeoutMs;
			const iter = source[Symbol.asyncIterator]();
			try {
				while (true) {
					const remaining = deadline - Date.now();
					if (remaining <= 0) {
						throw new TimeoutError(kind, timeoutMs, "stream");
					}
					let timer: ReturnType<typeof setTimeout> | undefined;
					const timeoutPromise = new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							reject(new TimeoutError(kind, timeoutMs, "stream"));
						}, remaining);
					});
					let step: IteratorResult<T>;
					try {
						step = await Promise.race([iter.next(), timeoutPromise]);
					} finally {
						if (timer !== undefined) clearTimeout(timer);
					}
					if (step.done) return;
					yield step.value;
				}
			} finally {
				// Signal the source iterator to release any held resources
				// (process handles, sockets, etc.) on early break / timeout.
				await iter.return?.().catch(() => {});
			}
		},
	};
}
