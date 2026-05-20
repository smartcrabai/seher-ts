import { describe, expect, test } from "bun:test";
import { TimeoutError, withStreamTimeout, withTimeout } from "./timeout.ts";

describe("withTimeout", () => {
	test("undefined timeout passes through", async () => {
		const result = await withTimeout(Promise.resolve(42), undefined, "claude");
		expect(result).toBe(42);
	});

	test("resolves before deadline", async () => {
		const fast = new Promise<string>((resolve) =>
			setTimeout(() => resolve("ok"), 5),
		);
		const result = await withTimeout(fast, 1000, "claude");
		expect(result).toBe("ok");
	});

	test("rejects with TimeoutError on deadline", async () => {
		const slow = new Promise<string>((resolve) =>
			setTimeout(() => resolve("late"), 200),
		);
		await expect(withTimeout(slow, 20, "claude")).rejects.toMatchObject({
			name: "TimeoutError",
			kind: "claude",
			timeoutMs: 20,
		});
	});

	test("forwards underlying rejection", async () => {
		const fail = Promise.reject(new Error("boom"));
		await expect(withTimeout(fail, 1000, "codex")).rejects.toThrow("boom");
	});
});

describe("withStreamTimeout", () => {
	async function* slowIter(items: number[], delayMs: number) {
		for (const item of items) {
			await new Promise((r) => setTimeout(r, delayMs));
			yield item;
		}
	}

	test("undefined timeout passes through (same reference)", () => {
		const src = slowIter([1, 2, 3], 0);
		expect(withStreamTimeout(src, undefined, "claude")).toBe(src);
	});

	test("yields all chunks within deadline", async () => {
		const collected: number[] = [];
		for await (const v of withStreamTimeout(
			slowIter([1, 2, 3], 5),
			1000,
			"claude",
		)) {
			collected.push(v);
		}
		expect(collected).toEqual([1, 2, 3]);
	});

	test("throws TimeoutError when total elapsed exceeds deadline", async () => {
		const wrapped = withStreamTimeout(slowIter([1, 2, 3], 50), 30, "claude");
		const iter = wrapped[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toMatchObject({
			name: "TimeoutError",
			kind: "claude",
		});
	});

	test("calls source iter.return() on early break (resource cleanup)", async () => {
		let returnCalled = false;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				let i = 0;
				return {
					async next() {
						return { value: i++, done: false };
					},
					async return() {
						returnCalled = true;
						return { value: undefined, done: true as const };
					},
				};
			},
		};
		for await (const v of withStreamTimeout(source, 1000, "claude")) {
			if (v >= 1) break;
		}
		expect(returnCalled).toBe(true);
	});

	test("calls source iter.return() on timeout", async () => {
		let returnCalled = false;
		const source: AsyncIterable<number> = {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						await new Promise((r) => setTimeout(r, 200));
						return { value: 1, done: false };
					},
					async return() {
						returnCalled = true;
						return { value: undefined, done: true as const };
					},
				};
			},
		};
		const wrapped = withStreamTimeout(source, 20, "claude");
		await expect(
			(async () => {
				for await (const _ of wrapped) {
					// drain
				}
			})(),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(returnCalled).toBe(true);
	});
});

describe("TimeoutError", () => {
	test("message includes kind and ms", () => {
		const err = new TimeoutError("kimi", 5_000, "run");
		expect(err.message).toBe("kimi run timed out after 5000ms");
		expect(err.name).toBe("TimeoutError");
		expect(err.kind).toBe("kimi");
		expect(err.timeoutMs).toBe(5_000);
	});
});
