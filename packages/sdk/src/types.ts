/**
 * Shared type definitions for seher-ts.
 *
 * These mirror the Rust implementation in `seher/src/config/mod.rs` so that the
 * JSONC settings file remains compatible between the two implementations.
 */

/**
 * Provider used for rate-limit tracking.
 *
 * Mirrors the Rust `enum ProviderConfig`:
 * - `inferred`: field absent -> provider is inferred from the command name.
 * - `explicit`: field has a string value -> use that provider name.
 * - `none`:     field is explicitly `null` -> no provider (fallback agent).
 */
export type ProviderConfig =
	| { kind: "inferred" }
	| { kind: "explicit"; name: string }
	| { kind: "none" };

/** Which SDK to drive this agent with, when invoked via the SDK surface. */
export type SdkKind = "claude" | "codex" | "copilot" | "kimi";

/**
 * Weekday / hour range schedule.
 *
 * - `weekdays`: ranges in "start-end" form (0=Sun .. 6=Sat, inclusive).
 *   Example: `["1-5"]` -> Mon through Fri.
 * - `hours`: ranges in "start-end" form, half-open [start, end), 0..48.
 *   Example: `["21-27"]` -> 21:00 through 03:00 next day.
 */
export interface ScheduleRule {
	weekdays?: string[];
	hours?: string[];
}

export interface AgentConfig {
	command: string;
	args: string[];
	models: Record<string, string> | null;
	arg_maps: Record<string, string[]>;
	env: Record<string, string> | null;
	provider: ProviderConfig;
	openrouter_management_key?: string;
	glm_api_key?: string;
	pre_command: string[];
	active: ScheduleRule | null;
	inactive: ScheduleRule | null;
	sdk?: SdkKind | null;
}

export interface PriorityRule {
	command: string;
	provider: ProviderConfig;
	model: string | null;
	priority: number;
	weekdays?: string[];
	hours?: string[];
}

export interface Settings {
	priority: PriorityRule[];
	agents: AgentConfig[];
}

/**
 * Whether an agent is currently rate-limited.
 *
 * `resetTime` is the moment the limit is expected to reset (local time).
 */
export type AgentLimit =
	| { kind: "not_limited" }
	| { kind: "limited"; resetTime: Date };

export interface AgentStatus {
	command: string;
	provider: string | null;
	limit: AgentLimit;
	/** Original CodexBar payload, retained for debugging / advanced callers. */
	raw?: unknown;
}
