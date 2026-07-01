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
	test("detects 429 and 5xx (500/502/503/504)", () => {
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

	test("rejects 4xx and misleading partial matches", () => {
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

	test("returns false for an empty string or a partial needle match", () => {
		expect(isTransientHttpError("")).toBe(false);
		expect(isTransientHttpError("HTTP")).toBe(false);
		expect(isTransientHttpError("HTTP 5")).toBe(false);
	});
});

describe("isClientErrorRetryable", () => {
	test("detects 401 and 404", () => {
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 401): auth_error"),
		).toBe(true);
		expect(
			isClientErrorRetryable("Anthropic API error (HTTP 404): not found"),
		).toBe(true);
	});

	test("rejects other statuses and misleading partial matches", () => {
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
	test("transient HTTP errors are true regardless of retryClientErrors", () => {
		const off = makeRetry({ retryClientErrors: false });
		const on = makeRetry({ retryClientErrors: true });
		const msg = "Anthropic API error (HTTP 503): unavailable";
		expect(isRetryableMessage(msg, off)).toBe(true);
		expect(isRetryableMessage(msg, on)).toBe(true);
	});

	test("client errors are true only when retryClientErrors=true", () => {
		const off = makeRetry({ retryClientErrors: false });
		const on = makeRetry({ retryClientErrors: true });
		const msg = "Anthropic API error (HTTP 401): auth_error";
		expect(isRetryableMessage(msg, off)).toBe(false);
		expect(isRetryableMessage(msg, on)).toBe(true);
	});

	test("non-retryable messages are false under any config", () => {
		const r = makeRetry({ retryClientErrors: true });
		expect(isRetryableMessage("connection refused", r)).toBe(false);
		expect(
			isRetryableMessage("Anthropic API error (HTTP 400): bad request", r),
		).toBe(false);
	});
});

describe("effectiveMaxAttempts / effectiveMultiplier", () => {
	test("maxAttempts is clamped to a minimum of 1", () => {
		expect(effectiveMaxAttempts(makeRetry({ maxAttempts: 0 }))).toBe(1);
		expect(effectiveMaxAttempts(makeRetry({ maxAttempts: 5 }))).toBe(5);
	});

	test("multiplier below 1.0 is clamped to 1.0 (prevents decay)", () => {
		expect(effectiveMultiplier(makeRetry({ multiplier: 0.5 }))).toBe(1.0);
		expect(effectiveMultiplier(makeRetry({ multiplier: 1.0 }))).toBe(1.0);
		expect(effectiveMultiplier(makeRetry({ multiplier: 2.5 }))).toBe(2.5);
	});
});

describe("delayForAttempt", () => {
	test("with defaults (2s, x2.0), attempts 1/2/3 are 2s / 4s / 8s", () => {
		const r = makeRetry();
		expect(delayForAttempt(1, r)).toBe(2_000);
		expect(delayForAttempt(2, r)).toBe(4_000);
		expect(delayForAttempt(3, r)).toBe(8_000);
	});

	test("is capped by maxDelaySecs", () => {
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

	test("delay never decays below initialDelay even when multiplier<1", () => {
		const r = makeRetry({
			initialDelaySecs: 5,
			multiplier: 0.1,
			maxDelaySecs: 60,
		});
		// effectiveMultiplier is raised to 1.0, so every attempt is 5s.
		expect(delayForAttempt(1, r)).toBe(5_000);
		expect(delayForAttempt(2, r)).toBe(5_000);
		expect(delayForAttempt(5, r)).toBe(5_000);
	});

	test("returns the initialDelay for attempt 0 or negative without throwing", () => {
		const r = makeRetry({ initialDelaySecs: 3, maxDelaySecs: 100 });
		expect(delayForAttempt(0, r)).toBe(3_000);
		expect(delayForAttempt(-5, r)).toBe(3_000);
	});
});
