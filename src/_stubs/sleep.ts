// TODO(post-merge): replace with import from ../sleep.
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

export interface SleepOptions {
	quiet?: boolean;
}

export async function sleepUntil(
	_target: Date,
	_opts?: SleepOptions,
): Promise<void> {
	// no-op stub
}
