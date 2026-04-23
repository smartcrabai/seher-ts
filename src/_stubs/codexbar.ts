// TODO(post-merge): replace with import from ../codexbar.
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

import type { AgentLimit } from "./types.ts";

export async function checkLimit(
	_provider: string | undefined,
): Promise<AgentLimit> {
	return { kind: "not_limited" };
}
