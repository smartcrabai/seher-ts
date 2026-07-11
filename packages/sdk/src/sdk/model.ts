import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

/**
 * Handling of the `:thinking` suffix on model IDs.
 *
 * The `model` value in `config.yaml` can specify a pi thinking level using
 * the `model:thinking` form (e.g. `anthropic/claude-opus-4-5:high`). This
 * module extracts the trailing `:level` and returns it as a `ThinkingLevel`
 * when recognized. Unrecognized suffixes (such as the OpenRouter `:free`
 * variant) are returned unchanged, so existing model IDs are never broken.
 */

/**
 * pi's thinking level. Matches the normalized literals accepted by
 * pi-coding-agent (`@earendil-works/pi-agent-core`).
 */
export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh";

/**
 * Table of recognized thinking levels and their aliases. Kept fully in sync
 * with the `ThinkingLevel::FromStr` implementation in the Rust-side pi
 * crate (`off` / `none` / `0`, `minimal` / `min`, `low` / `1`,
 * `medium` / `med` / `2`, `high` / `3`, `xhigh` / `4`).
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
 * Interprets `suffix` as a thinking level. Returns `undefined` if it isn't
 * recognized. Comparison is done after lowercasing and trimming.
 */
function parseThinkingLevel(suffix: string): ThinkingLevel | undefined {
	const normalized = suffix.trim().toLowerCase();
	if (normalized === "" || !Object.hasOwn(THINKING_ALIASES, normalized)) {
		return undefined;
	}
	return THINKING_ALIASES[normalized];
}

/**
 * Extracts the trailing `:level` thinking suffix from a model ID.
 *
 * - Only strips the suffix and returns `thinking` if it's a recognized
 *   thinking level, **or** the literal `max` (case-insensitive). `max` has no
 *   `pi::model::ThinkingLevel` equivalent, but is still a valid `EffortLevel`
 *   tier -- recognizing it here (rather than leaving it stuck on the model
 *   id) matches the Rust side's `split_thinking_suffix` fix. The raw `"max"`
 *   string is passed through as-is and is expected to surface a clear runtime
 *   validation error from pi itself if it ever reaches `thinkingLevel`
 *   unmapped (see `effortToThinking`, which is how a `max` *effort* actually
 *   reaches pi -- mapped to `"xhigh"`).
 * - Unrecognized suffixes (e.g. `:free`) are left in `base` as-is.
 * - If there is no `:`, the original string is returned as `base`.
 *
 * The provider separator `/` is ignored; only the **last** `:` is
 * considered. For `anthropic/claude-opus-4-5:high`, the base is
 * `anthropic/claude-opus-4-5`.
 */
export function splitThinkingSuffix(modelId: string): {
	base: string;
	thinking?: ThinkingLevel | "max";
} {
	const colon = modelId.lastIndexOf(":");
	if (colon < 0) return { base: modelId };
	const suffix = modelId.slice(colon + 1);
	if (suffix.trim().toLowerCase() === "max") {
		return { base: modelId.slice(0, colon), thinking: "max" };
	}
	const thinking = parseThinkingLevel(suffix);
	if (thinking === undefined) return { base: modelId };
	return { base: modelId.slice(0, colon), thinking };
}

export type { EffortLevel };

/**
 * Canonical names of recognized effort levels. Kept exactly in sync with the
 * 5 values (low/medium/high/xhigh/max) accepted by `Options.effort` in
 * `@anthropic-ai/claude-agent-sdk` and the `claude --effort` CLI flag.
 */
export const EFFORT_LEVELS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly EffortLevel[];

/**
 * Table of suffix aliases recognized as an effort level, kept in sync with
 * the Rust side's `effort_from_suffix`. Unlike pi's thinking-level vocabulary
 * (`THINKING_ALIASES`), `EffortLevel` has no separate "minimal" tier, so
 * `minimal`/`min`/`low`/`1` all collapse to `"low"`.
 */
const EFFORT_SUFFIX_ALIASES: Readonly<Record<string, EffortLevel>> = {
	minimal: "low",
	min: "low",
	low: "low",
	"1": "low",
	medium: "medium",
	med: "medium",
	"2": "medium",
	high: "high",
	"3": "high",
	xhigh: "xhigh",
	"4": "xhigh",
	max: "max",
};

/**
 * Suffixes recognized as a valid pi thinking tier but with no `EffortLevel`
 * equivalent -- pi's "off" tier has no matching `claude --effort` value.
 * Still stripped from the model id (matching the Rust side's
 * `split_thinking_suffix`/`effort_from_suffix` split), just without setting
 * `effort`.
 */
const EFFORT_SUFFIX_NO_EQUIVALENT: ReadonlySet<string> = new Set([
	"off",
	"none",
	"0",
]);

/**
 * Interprets `suffix` as an effort suffix. `recognized` is `true` when the
 * suffix should be stripped from the model id at all (either because it maps
 * to an `EffortLevel`, or because it's a pi thinking tier with no `EffortLevel`
 * equivalent); `effort` is only set in the former case. Comparison is done
 * after lowercasing and trimming.
 */
function parseEffortSuffix(suffix: string): {
	recognized: boolean;
	effort?: EffortLevel;
} {
	const normalized = suffix.trim().toLowerCase();
	if (normalized === "") return { recognized: false };
	if (Object.hasOwn(EFFORT_SUFFIX_ALIASES, normalized)) {
		// biome-ignore lint/style/noNonNullAssertion: hasOwn-guarded
		return { recognized: true, effort: EFFORT_SUFFIX_ALIASES[normalized]! };
	}
	if (EFFORT_SUFFIX_NO_EQUIVALENT.has(normalized)) {
		return { recognized: true };
	}
	return { recognized: false };
}

/**
 * Extracts the trailing `:level` effort suffix from a model ID. This is the
 * effort counterpart to `splitThinkingSuffix`, interpreted independently of
 * pi's thinking level by the Claude-family SDKs (`claude` /
 * `claude-headless` / `claude-terminal`).
 *
 * - Strips the suffix whenever it's recognized as a pi thinking tier or the
 *   `max` alias (kept in sync with the Rust side's `effort_from_suffix`
 *   vocabulary: `minimal`/`min`/`low`/`1`, `medium`/`med`/`2`, `high`/`3`,
 *   `xhigh`/`4`, `max`, plus `off`/`none`/`0`).
 * - `effort` is set to the mapped `EffortLevel` when there is one. `off` /
 *   `none` / `0` have no `EffortLevel` equivalent (the `claude --effort` flag
 *   has no "off" tier), so the suffix is still stripped from `base` but
 *   `effort` stays `undefined` -- no `--effort` flag is emitted rather than
 *   guessing a tier.
 * - Unrecognized suffixes (e.g. `:free`) are left in `base` as-is.
 * - The provider separator `/` is ignored; only the **last** `:` is
 *   considered.
 */
export function splitEffortSuffix(modelId: string): {
	base: string;
	effort?: EffortLevel;
} {
	const colon = modelId.lastIndexOf(":");
	if (colon < 0) return { base: modelId };
	const suffix = modelId.slice(colon + 1);
	const parsed = parseEffortSuffix(suffix);
	if (!parsed.recognized) return { base: modelId };
	const result: { base: string; effort?: EffortLevel } = {
		base: modelId.slice(0, colon),
	};
	if (parsed.effort !== undefined) result.effort = parsed.effort;
	return result;
}

/**
 * Maps an `EffortLevel` to pi's thinking-level string. `pi`'s `ThinkingLevel`
 * has no `max` variant, so `EffortLevel` `"max"` maps to pi's highest tier,
 * `"xhigh"`. Every other variant has an identically named pi thinking level.
 * Mirrors the Rust side's `effort_to_thinking`.
 */
export function effortToThinking(effort: EffortLevel): ThinkingLevel {
	switch (effort) {
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "xhigh";
	}
}
