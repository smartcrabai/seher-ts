// TODO(post-merge): replace with import from ../cli/prompt or appropriate module.
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

export async function collectPrompt(
	trailing: string[],
): Promise<string | null> {
	const joined = trailing.join(" ");
	return joined.length > 0 ? joined : null;
}
