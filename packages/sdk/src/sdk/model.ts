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
 *   thinking level.
 * - Unrecognized suffixes (e.g. `:free`) are left in `base` as-is.
 * - If there is no `:`, the original string is returned as `base`.
 *
 * The provider separator `/` is ignored; only the **last** `:` is
 * considered. For `anthropic/claude-opus-4-5:high`, the base is
 * `anthropic/claude-opus-4-5`.
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
 * Interprets `suffix` as an effort level. Returns `undefined` if it isn't
 * recognized. Comparison is done after lowercasing and trimming. No aliases
 * are defined; only the canonical names in `EFFORT_LEVELS` are accepted, to
 * keep the vocabulary consistent with the `claude --effort` CLI and the
 * YAML `models.<mode>.effort` field.
 */
function parseEffortLevel(suffix: string): EffortLevel | undefined {
	const normalized = suffix.trim().toLowerCase();
	if (normalized === "") return undefined;
	return (EFFORT_LEVELS as readonly string[]).includes(normalized)
		? (normalized as EffortLevel)
		: undefined;
}

/**
 * Extracts the trailing `:level` effort suffix from a model ID. This is the
 * effort counterpart to `splitThinkingSuffix`, interpreted independently of
 * pi's thinking level by the Claude-family SDKs (`claude` /
 * `claude-headless` / `claude-terminal`).
 *
 * - Only strips the suffix and returns `effort` if it's a recognized effort
 *   level.
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
	const effort = parseEffortLevel(suffix);
	if (effort === undefined) return { base: modelId };
	return { base: modelId.slice(0, colon), effort };
}
