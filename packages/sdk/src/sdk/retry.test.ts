import { describe, expect, test } from "bun:test";
import { DEFAULT_RETRY_CONFIG, type ResolvedRetryConfig } from "../types.ts";
import {
	delayForAttempt,
	effectiveMaxAttempts,
	effectiveMultiplier,
	isClientErrorRetryable,
	isRetryableMessage,
	isTransientHttpError,
} from "./retry.ts";

function makeRetry(
	override: Partial<ResolvedRetryConfig> = {},
): ResolvedRetryConfig {
	return { ...DEFAULT_RETRY_CONFIG, ...override };
}

describe("isTransientHttpError", () => {
	test("429 と 5xx (500/502/503/504) を検出する", () => {
		expect(
			isTransientHttpError("Anthropic API error (HTTP 429): rate limited"),
		).toBe(true);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 500): internal"),
		).toBe(true);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 502): bad gateway"),
		).toBe(true);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 503): unavailable"),
		).toBe(true);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 504): timeout"),
		).toBe(true);
	});

	test("4xx および誤誘導される部分一致を拒否する", () => {
		expect(
			isTransientHttpError("Anthropic API error (HTTP 401): auth_error"),
		).toBe(false);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 403): forbidden"),
		).toBe(false);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 404): not found"),
		).toBe(false);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 400): bad request"),
		).toBe(false);
		expect(isTransientHttpError("connection refused")).toBe(false);
		expect(isTransientHttpError("Read 50029 bytes")).toBe(false);
		expect(isTransientHttpError("Read 5029 bytes")).toBe(false);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 5002): unknown"),
		).toBe(false);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 5029): unknown"),
		).toBe(false);
		expect(
			isTransientHttpError("Anthropic API error (HTTP 4290): unknown"),
		).toBe(false);
	});

	test("空文字や needle 部分一致でも false", () => {
		expect(isTransientHttpError("")).toBe(false);
		expect(isTransientHttpError("HTTP")).toBe(false);
		expect(isTransientHttpError("HTTP 5")).toBe(false);
	});
});

describe("isClientErrorRetryable", () => {
	test("401 と 404 を検出する", () => {
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 401): auth_error"),
		).toBe(true);
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 404): not found"),
		).toBe(true);
	});

	test("それ以外のステータスや誤誘導部分一致を拒否する", () => {
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 403): forbidden"),
		).toBe(false);
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 500): internal"),
		).toBe(false);
		expect(isClientErrorRetryable("connection refused")).toBe(false);
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 4012): auth_error"),
		).toBe(false);
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 4040): not found"),
		).toBe(false);
	});
});

describe("isRetryableMessage", () => {
	test("transient HTTP エラーは retryClientErrors の値に依らず true", () => {
		const off = makeRetry({ retryClientErrors: false });
		const on = makeRetry({ retryClientErrors: true });
		const msg = "Anthropic API error (HTTP 503): unavailable";
		expect(isRetryableMessage(msg, off)).toBe(true);
		expect(isRetryableMessage(msg, on)).toBe(true);
	});

	test("クライアントエラーは retryClientErrors=true のときだけ true", () => {
		const off = makeRetry({ retryClientErrors: false });
		const on = makeRetry({ retryClientErrors: true });
		const msg = "Anthropic API error (HTTP 401): auth_error";
		expect(isRetryableMessage(msg, off)).toBe(false);
		expect(isRetryableMessage(msg, on)).toBe(true);
	});

	test("リトライ不能なメッセージはどの設定でも false", () => {
		const r = makeRetry({ retryClientErrors: true });
		expect(isRetryableMessage("connection refused", r)).toBe(false);
		expect(
			isRetryableMessage("Anthropic API error (HTTP 400): bad request", r),
		).toBe(false);
	});
});

describe("effectiveMaxAttempts / effectiveMultiplier", () => {
	test("maxAttempts は最低 1 にクランプ", () => {
		expect(effectiveMaxAttempts(makeRetry({ maxAttempts: 0 }))).toBe(1);
		expect(effectiveMaxAttempts(makeRetry({ maxAttempts: 5 }))).toBe(5);
	});

	test("multiplier は 1.0 未満を 1.0 にクランプ (decay 防止)", () => {
		expect(effectiveMultiplier(makeRetry({ multiplier: 0.5 }))).toBe(1.0);
		expect(effectiveMultiplier(makeRetry({ multiplier: 1.0 }))).toBe(1.0);
		expect(effectiveMultiplier(makeRetry({ multiplier: 2.5 }))).toBe(2.5);
	});
});

describe("delayForAttempt", () => {
	test("デフォルト (2s, ×2.0) で 1/2/3 回目は 2s / 4s / 8s", () => {
		const r = makeRetry();
		expect(delayForAttempt(1, r)).toBe(2_000);
		expect(delayForAttempt(2, r)).toBe(4_000);
		expect(delayForAttempt(3, r)).toBe(8_000);
	});

	test("maxDelaySecs でキャップされる", () => {
		const r = makeRetry({
			initialDelaySecs: 2,
			multiplier: 2.0,
			maxDelaySecs: 10,
		});
		expect(delayForAttempt(1, r)).toBe(2_000);
		expect(delayForAttempt(2, r)).toBe(4_000);
		expect(delayForAttempt(3, r)).toBe(8_000);
		expect(delayForAttempt(4, r)).toBe(10_000);
		expect(delayForAttempt(10, r)).toBe(10_000);
	});

	test("multiplier<1 でも遅延が initialDelay 未満に decay しない", () => {
		const r = makeRetry({
			initialDelaySecs: 5,
			multiplier: 0.1,
			maxDelaySecs: 60,
		});
		// effectiveMultiplier は 1.0 に持ち上がるので、毎回 5s。
		expect(delayForAttempt(1, r)).toBe(5_000);
		expect(delayForAttempt(2, r)).toBe(5_000);
		expect(delayForAttempt(5, r)).toBe(5_000);
	});

	test("attempt が 0 や負でも例外を出さず initialDelay 相当を返す", () => {
		const r = makeRetry({ initialDelaySecs: 3, maxDelaySecs: 100 });
		expect(delayForAttempt(0, r)).toBe(3_000);
		expect(delayForAttempt(-5, r)).toBe(3_000);
	});
});
