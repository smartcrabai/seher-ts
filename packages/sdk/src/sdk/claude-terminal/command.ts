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
	/** Reasoning effort fallback when `model` carries no recognized `:level` suffix. */
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
	const effectiveEffort = suffixEffort ?? opts.effortLevel;
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
