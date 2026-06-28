import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { splitThinkingSuffix } from "../model.ts";

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
}

export function buildClaudeCommand(opts: BuildClaudeCommandOptions): string[] {
	const args: string[] = [opts.claudeBin];
	if (opts.model !== undefined) {
		// claude-terminal は thinking 非対応のため、認識したサフィックスは
		// strip して base のみを `--model` に渡す。`:free` のような未認識
		// サフィックスは原文を維持する。
		const { base } = splitThinkingSuffix(opts.model);
		args.push("--model", base);
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
