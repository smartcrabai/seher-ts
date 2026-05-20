export interface BuildClaudeCommandOptions {
	claudeBin: string;
	model?: string;
	systemPrompt?: string;
	dangerouslySkipPermissions?: boolean;
}

export function buildClaudeCommand(opts: BuildClaudeCommandOptions): string[] {
	const args: string[] = [opts.claudeBin];
	if (opts.model !== undefined) {
		args.push("--model", opts.model);
	}
	if (opts.systemPrompt !== undefined) {
		args.push("--append-system-prompt", opts.systemPrompt);
	}
	if (opts.dangerouslySkipPermissions) {
		args.push("--dangerously-skip-permissions");
	}
	return args;
}
