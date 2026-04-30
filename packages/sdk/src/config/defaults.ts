import type { Settings } from "../types.ts";

export function defaultSettings(): Settings {
	return { agents: [], priority: [] };
}
