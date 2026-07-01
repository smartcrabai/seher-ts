import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/**
 * モデル ID の `:thinking` サフィックス処理。
 *
 * `config.yaml` の `model` 値には `model:thinking` 形式で pi の thinking
 * レベルを指定できる(例: `anthropic/claude-opus-4-5:high`)。本モジュー
 * ルは末尾の `:level` を切り出し、認識できれば `ThinkingLevel` として返
 * す。認識できないサフィックス(OpenRouter の `:free` variant 等)は原
 * 文をそのまま返すため、既存のモデル ID を壊さない。
 */

/**
 * pi の thinking レベル。pi-coding-agent (`@earendil-works/pi-agent-core`)
 * が受け付ける正規化済みリテラルと一致する。
 */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

/**
 * 認識する thinking レベルとエイリアスの対応表。Rust 側 pi クレートの
 * `ThinkingLevel::FromStr` 実装と完全に一致させてある(`off` / `none` /
 * `0`、`minimal` / `min`、`low` / `1`、`medium` / `med` / `2`、`high` /
 * `3`、`xhigh` / `4`)。
 */
const THINKING_ALIASES: Readonly<Record<string, ThinkingLevel>> = {
	off: "off",
	none: "off",
	"0": "off",
	minimal: "minimal",
	min: "minimal",
	low: "low",
	"1": "low",
	medium: "medium",
	med: "medium",
	"2": "medium",
	high: "high",
	"3": "high",
	xhigh: "xhigh",
	"4": "xhigh",
};

/**
 * `suffix` を thinking レベルとして解釈する。認識できなければ
 * `undefined` を返す。比較は小文字化・トリム済みで行う。
 */
function parseThinkingLevel(suffix: string): ThinkingLevel | undefined {
	const normalized = suffix.trim().toLowerCase();
	if (normalized === "" || !Object.hasOwn(THINKING_ALIASES, normalized)) {
		return undefined;
	}
	return THINKING_ALIASES[normalized];
}

/**
 * モデル ID 末尾の `:level` thinking サフィックスを切り出す。
 *
 * - サフィックスが認識可能な thinking レベルだった場合のみ strip して
 *   `thinking` を返す。
 * - 認識できないサフィックス(`:free` 等)はそのまま `base` に残す。
 * - `:` を含まない場合は原文を `base` として返す。
 *
 * provider 区切り `/` は無視し、**最後の** `:` だけを判定対象にする。
 * `anthropic/claude-opus-4-5:high` の base は `anthropic/claude-opus-4-5`。
 */
export function splitThinkingSuffix(modelId: string): {
	base: string;
	thinking?: ThinkingLevel;
} {
	const colon = modelId.lastIndexOf(":");
	if (colon < 0) return { base: modelId };
	const suffix = modelId.slice(colon + 1);
	const thinking = parseThinkingLevel(suffix);
	if (thinking === undefined) return { base: modelId };
	return { base: modelId.slice(0, colon), thinking };
}

export type { EffortLevel };

/**
 * 認識する effort level の正規名。`@anthropic-ai/claude-agent-sdk` の
 * `Options.effort` / `claude --effort` CLI フラグが受け付ける 5 値
 * (low/medium/high/xhigh/max) と完全一致させる。
 */
export const EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly EffortLevel[];

/**
 * `suffix` を effort レベルとして解釈する。認識できなければ `undefined`
 * を返す。比較は小文字化・トリム済みで行う。エイリアスは設けず
 * `EFFORT_LEVELS` の正規名のみを受け付ける(`claude --effort` CLI /
 * YAML `models.<mode>.effort` と同じ語彙に統一するため)。
 */
function parseEffortLevel(suffix: string): EffortLevel | undefined {
	const normalized = suffix.trim().toLowerCase();
	if (normalized === "") return undefined;
	return (EFFORT_LEVELS as readonly string[]).includes(normalized)
		? (normalized as EffortLevel)
		: undefined;
}

/**
 * モデル ID 末尾の `:level` effort サフィックスを切り出す。`splitThinkingSuffix`
 * の effort 版で、pi 向けの thinking レベルとは独立に Claude 系 SDK
 * (`claude` / `claude-headless` / `claude-terminal`) が解釈する。
 *
 * - サフィックスが認識可能な effort レベルだった場合のみ strip して
 *   `effort` を返す。
 * - 認識できないサフィックス(`:free` 等)はそのまま `base` に残す。
 * - provider 区切り `/` は無視し、**最後の** `:` だけを判定対象にする。
 */
export function splitEffortSuffix(modelId: string): {
	base: string;
	effort?: EffortLevel;
} {
	const colon = modelId.lastIndexOf(":");
	if (colon < 0) return { base: modelId };
	const suffix = modelId.slice(colon + 1);
	const effort = parseEffortLevel(suffix);
	if (effort === undefined) return { base: modelId };
	return { base: modelId.slice(0, colon), effort };
}
