import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import type { Settings } from "../types.ts";
import { defaultSettings } from "./defaults.ts";
import { ConfigValidationError, validateSettings } from "./validate.ts";

export class ConfigLoadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigLoadError";
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

async function readIfExists(path: string): Promise<string | null> {
	if (!(await fileExists(path))) return null;
	return await readFile(path, "utf8");
}

async function resolveDefaultPath(): Promise<string | null> {
	const dir = join(homedir(), ".config", "seher");
	for (const name of ["settings.jsonc", "settings.json"]) {
		const p = join(dir, name);
		if (await fileExists(p)) return p;
	}
	return null;
}

export function parseSettingsText(text: string, sourceLabel: string): Settings {
	const errors: ParseError[] = [];
	const parsed = parse(text, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length > 0) {
		const details = errors
			.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
			.join("; ");
		throw new ConfigLoadError(`failed to parse ${sourceLabel}: ${details}`);
	}
	try {
		return validateSettings(parsed);
	} catch (err) {
		if (err instanceof ConfigValidationError) {
			throw new ConfigLoadError(
				`invalid settings in ${sourceLabel}: ${err.message}`,
			);
		}
		throw err;
	}
}

export async function loadSettings(explicitPath?: string): Promise<Settings> {
	// Rust loader treats NotFound as default for both explicit and default paths.
	const path = explicitPath ?? (await resolveDefaultPath());
	if (path === null) return defaultSettings();
	const text = await readIfExists(path);
	if (text === null) return defaultSettings();
	return parseSettingsText(text, path);
}
