// TODO(post-merge): replace with import from ../agent/run.
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

import type { Agent } from "./types.ts";

export interface RunAgentOptions {
	model?: string | undefined;
	trailingArgs: string[];
	quiet: boolean;
	prompt?: string | null | undefined;
}

export interface RunAgentResult {
	exitCode: number;
}

export async function runAgent(
	_agent: Agent,
	_opts: RunAgentOptions,
): Promise<RunAgentResult> {
	return { exitCode: 0 };
}
