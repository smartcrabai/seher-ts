// TODO(post-merge): replace with import from ../config/load.
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

import type { PriorityRule, Settings } from "./types.ts";

export async function loadSettings(_path?: string): Promise<Settings> {
	return {
		agents: [],
		priority: [] as PriorityRule[],
	};
}
