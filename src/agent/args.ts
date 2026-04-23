const MODEL_PLACEHOLDER = "{model}";

/**
 * Resolve the `{model}` placeholder inside an agent's argument template.
 *
 * When `selectedModel` is undefined, any template element containing
 * `{model}` is removed. If the preceding element looks like a flag
 * (e.g. `--model`), it is dropped together with the placeholder so that
 * dangling `--model` flags never reach the child process.
 *
 * When a model is selected, `{model}` is replaced by the mapped value
 * from `modelsMap` or the raw key when no mapping exists.
 */
export function resolveArgs(
	template: string[],
	selectedModel: string | undefined,
	modelsMap: Record<string, string> | null,
): string[] {
	const out: string[] = [];
	for (const arg of template) {
		if (arg.includes(MODEL_PLACEHOLDER)) {
			if (selectedModel === undefined) {
				// Drop this arg, and drop the preceding flag if one was emitted.
				const prev = out.at(-1);
				if (prev?.startsWith("-")) {
					out.pop();
				}
				continue;
			}
			const replacement = modelsMap?.[selectedModel] ?? selectedModel;
			out.push(arg.replaceAll(MODEL_PLACEHOLDER, replacement));
		} else {
			out.push(arg);
		}
	}

	// When no models map is configured and the caller passed a model,
	// forward it as `--model <value>` (mirrors Rust's resolved_args).
	if (modelsMap === null && selectedModel !== undefined) {
		out.push("--model", selectedModel);
	}

	return out;
}

/**
 * Expand trailing args using the agent's arg_maps table.
 * Tokens that match a key are replaced with the mapped tokens; everything
 * else passes through unchanged.
 */
export function applyArgMaps(
	trailing: string[],
	argMaps: Record<string, string[]>,
): string[] {
	const out: string[] = [];
	for (const token of trailing) {
		const mapped = argMaps[token];
		if (mapped !== undefined) {
			out.push(...mapped);
		} else {
			out.push(token);
		}
	}
	return out;
}
