/**
 * 一時的なプロバイダ API エラーに対する指数バックオフ再試行ヘルパ。
 *
 * Rust 実装 (`seher::sdk::config::RetryConfig` および
 * `seher::sdk::errors`) を TypeScript に移植したもの。SDK 内部の
 * `seherSdk.ts` と CLI の retry hook の双方から利用する。
 */

import type { ResolvedRetryConfig } from "../types.ts";

/**
 * 文字列に `HTTP <status>` が含まれており、かつ直後が数字でない
 * (= 文字列終端または非数字) ことを確認する。
 *
 * `HTTP 5002` のような誤検知を防ぐためのヘルパで、Rust 側の
 * `contains_http_status` と等価。
 */
function containsHttpStatus(message: string, status: number): boolean {
	const needle = `HTTP ${status}`;
	let from = 0;
	while (true) {
		const idx = message.indexOf(needle, from);
		if (idx < 0) return false;
		const next = message.charAt(idx + needle.length);
		// 文字列終端、または直後が ASCII 数字でなければ採用。
		if (next === "" || next < "0" || next > "9") return true;
		from = idx + needle.length;
	}
}

/**
 * 常に再試行すべき一時的な HTTP エラーかを判定する。
 *
 * 対応ステータス: 429 / 500 / 502 / 503 / 504。`HTTP 5002` のような
 * 誤検知を避けるため、フル状態コードのみマッチさせる。
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
 * 明示的にオプトインした場合のみ再試行する HTTP クライアントエラーか判定。
 *
 * Kimi のような一部プロバイダは過渡的に 401/404 を返すことがあるが、
 * 通常これらは認証/ルーティング失敗を示すため `retryClientErrors` が
 * true のときだけリトライする。
 */
export function isClientErrorRetryable(message: string): boolean {
	return containsHttpStatus(message, 401) || containsHttpStatus(message, 404);
}

/**
 * このリトライポリシー下で `message` が再試行対象かを判定。
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
 * ユーザーがバリデーションを迂回して `maxAttempts: 0` を指定した場合でも
 * 安全な値を返す (最小 1)。
 */
export function effectiveMaxAttempts(retry: ResolvedRetryConfig): number {
	return Math.max(1, retry.maxAttempts);
}

/**
 * `multiplier < 1` だと遅延が減衰してしまうので 1.0 にクランプする。
 */
export function effectiveMultiplier(retry: ResolvedRetryConfig): number {
	return Math.max(1.0, retry.multiplier);
}

/**
 * 1 始まりの試行番号に対する待機ミリ秒を計算する。
 *
 * `min(maxDelaySecs, initialDelaySecs * multiplier^(attempt-1))` を
 * 秒単位で切り捨て、ミリ秒へ変換して返す (Rust 版と同じ離散化)。
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
