import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { type EffortLevel, splitEffortSuffix } from "../model.ts";

export interface BuildClaudeCommandOptions {
	claudeBin: string;
	permissionMode: PermissionMode;
	model?: string;
	systemPrompt?: string;
	/**
	 * Resume an existing transcript by session id. Forwarded as
	 * `claude --resume <id>` so the TUI loads the prior conversation under the
	 * same project (cwd) directory.
	 */
	resume?: string;
	/**
	 * Reasoning effort. Takes precedence over a recognized `:level` suffix on
	 * `model`, which is only used as a fallback when this is unset.
	 */
	effortLevel?: EffortLevel;
}

export function buildClaudeCommand(opts: BuildClaudeCommandOptions): string[] {
	const args: string[] = [opts.claudeBin];
	let suffixEffort: EffortLevel | undefined;
	if (opts.model !== undefined) {
		// claude-terminal does not support thinking, so a recognized suffix is
		// interpreted as effort, stripped, and only the base is passed to `--model`.
		// An unrecognized suffix (e.g. `:free`) is kept verbatim.
		const { base, effort } = splitEffortSuffix(opts.model);
		args.push("--model", base);
		suffixEffort = effort;
	}
	// opts.effortLevel (explicit / config-resolved) takes precedence over a
	// model-id suffix, which is only a fallback.
	const effectiveEffort = opts.effortLevel ?? suffixEffort;
	if (effectiveEffort !== undefined) {
		args.push("--effort", effectiveEffort);
	}
	if (opts.systemPrompt !== undefined) {
		args.push("--append-system-prompt", opts.systemPrompt);
	}
	if (opts.resume !== undefined) {
		args.push("--resume", opts.resume);
	}
	args.push("--permission-mode", opts.permissionMode);
	return args;
}
