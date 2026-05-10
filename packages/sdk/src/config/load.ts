import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "../types.ts";
import { defaultConfig } from "./defaults.ts";
import { ConfigValidationError, validateConfig } from "./validate.ts";

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

/**
 * Resolve the default config path:
 *   $SEHER_CONFIG > ~/.config/seher/config.yaml
 *
 * Returns the path string regardless of whether the file exists; the caller
 * decides whether to fall back to defaults.
 */
export function defaultConfigPath(): string {
	const env = process.env.SEHER_CONFIG;
	if (env !== undefined && env.length > 0) return env;
	return join(homedir(), ".config", "seher", "config.yaml");
}

export function parseConfigText(text: string, sourceLabel: string): Config {
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new ConfigLoadError(
			`failed to parse ${sourceLabel}: ${(err as Error).message}`,
		);
	}
	if (parsed === undefined || parsed === null) return defaultConfig();
	try {
		return validateConfig(parsed);
	} catch (err) {
		if (err instanceof ConfigValidationError) {
			throw new ConfigLoadError(
				`invalid config in ${sourceLabel}: ${err.message}`,
			);
		}
		throw err;
	}
}

export async function loadConfig(explicitPath?: string): Promise<Config> {
	const path = explicitPath ?? defaultConfigPath();
	const text = await readIfExists(path);
	if (text === null) return defaultConfig();
	return parseConfigText(text, path);
}
