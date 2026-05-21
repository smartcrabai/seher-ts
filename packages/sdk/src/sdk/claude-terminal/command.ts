import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

export interface BuildClaudeCommandOptions {
	claudeBin: string;
	permissionMode: PermissionMode;
	model?: string;
	systemPrompt?: string;
}

export function buildClaudeCommand(opts: BuildClaudeCommandOptions): string[] {
	const args: string[] = [opts.claudeBin];
	if (opts.model !== undefined) {
		args.push("--model", opts.model);
	}
	if (opts.systemPrompt !== undefined) {
		args.push("--append-system-prompt", opts.systemPrompt);
	}
	args.push("--permission-mode", opts.permissionMode);
	return args;
}
