export type Settings = {
	$schema?: string;
	agents?: unknown[];
	priority?: unknown[];
	[key: string]: unknown;
};

const ALLOWED_TOP_LEVEL_KEYS = new Set(["$schema", "agents", "priority"]);

export type ValidationResult =
	| { ok: true; value: Settings }
	| { ok: false; error: string };

export function validateSettings(input: unknown): ValidationResult {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, error: "settings must be a JSON object" };
	}
	const obj = input as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
			return { ok: false, error: `unknown top-level key: ${key}` };
		}
	}
	if (obj.$schema !== undefined && typeof obj.$schema !== "string") {
		return { ok: false, error: "$schema must be a string" };
	}
	if (obj.agents !== undefined && !Array.isArray(obj.agents)) {
		return { ok: false, error: "agents must be an array" };
	}
	if (obj.priority !== undefined && !Array.isArray(obj.priority)) {
		return { ok: false, error: "priority must be an array" };
	}
	return { ok: true, value: obj as Settings };
}
