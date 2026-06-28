import type {
	Config,
	ModelEntry,
	ProviderApi,
	ProviderEntry,
	RetryConfig,
	SdkKind,
	SkillsConfig,
} from "../types.ts";

export class ConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigValidationError";
	}
}

function fail(msg: string): never {
	throw new ConfigValidationError(msg);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SDK_KINDS: ReadonlySet<SdkKind> = new Set<SdkKind>([
	"claude",
	"claude-terminal",
	"codex",
	"copilot",
	"kimi",
	"opencode",
	"cursor",
	"pi",
]);

/** Provider key -> default SDK kind for the built-in providers. */
const DEFAULT_SDK_BY_PROVIDER: Readonly<Record<string, SdkKind>> = {
	codex: "codex",
	claude: "claude",
	"claude-terminal": "claude-terminal",
	cursor: "cursor",
	opencodego: "opencode",
	copilot: "copilot",
	kimi: "kimi",
};

function parseSdk(raw: unknown, label: string): SdkKind {
	if (typeof raw !== "string") {
		fail(`${label}.sdk must be a string`);
	}
	if (!SDK_KINDS.has(raw as SdkKind)) {
		fail(
			`${label}.sdk must be one of "claude", "claude-terminal", "codex", "copilot", "kimi", "opencode", "cursor", "pi"`,
		);
	}
	return raw as SdkKind;
}

function parseApi(raw: unknown, label: string): ProviderApi {
	if (!isPlainObject(raw)) {
		fail(`${label}.api must be an object`);
	}
	const api: ProviderApi = {};
	if ("key" in raw && raw.key !== undefined) {
		if (typeof raw.key !== "string") fail(`${label}.api.key must be a string`);
		api.key = raw.key;
	}
	if ("endpoint" in raw && raw.endpoint !== undefined) {
		if (typeof raw.endpoint !== "string") {
			fail(`${label}.api.endpoint must be a string`);
		}
		api.endpoint = raw.endpoint;
	}
	return api;
}

function parseSkills(raw: unknown, label: string): SkillsConfig {
	if (!isPlainObject(raw)) {
		fail(`${label} must be an object`);
	}
	const out: SkillsConfig = {};
	if ("includeClaude" in raw && raw.includeClaude !== undefined) {
		if (typeof raw.includeClaude !== "boolean") {
			fail(`${label}.includeClaude must be a boolean`);
		}
		out.includeClaude = raw.includeClaude;
	}
	return out;
}

function parseFiniteNumber(raw: unknown, label: string): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) {
		fail(`${label} must be a finite number`);
	}
	return raw;
}

function parseRetry(raw: unknown, label: string): RetryConfig {
	if (!isPlainObject(raw)) {
		fail(`${label} must be an object`);
	}
	const out: RetryConfig = {};
	if ("enabled" in raw && raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") {
			fail(`${label}.enabled must be a boolean`);
		}
		out.enabled = raw.enabled;
	}
	if ("maxAttempts" in raw && raw.maxAttempts !== undefined) {
		const n = parseFiniteNumber(raw.maxAttempts, `${label}.maxAttempts`);
		if (n < 1) {
			fail(`${label}.maxAttempts must be >= 1`);
		}
		out.maxAttempts = n;
	}
	if ("initialDelaySecs" in raw && raw.initialDelaySecs !== undefined) {
		const n = parseFiniteNumber(
			raw.initialDelaySecs,
			`${label}.initialDelaySecs`,
		);
		if (n < 0) {
			fail(`${label}.initialDelaySecs must be >= 0`);
		}
		out.initialDelaySecs = n;
	}
	if ("maxDelaySecs" in raw && raw.maxDelaySecs !== undefined) {
		const n = parseFiniteNumber(raw.maxDelaySecs, `${label}.maxDelaySecs`);
		if (n < 0) {
			fail(`${label}.maxDelaySecs must be >= 0`);
		}
		out.maxDelaySecs = n;
	}
	if ("multiplier" in raw && raw.multiplier !== undefined) {
		const n = parseFiniteNumber(raw.multiplier, `${label}.multiplier`);
		if (n < 1.0) {
			fail(`${label}.multiplier must be >= 1.0`);
		}
		out.multiplier = n;
	}
	if ("retryClientErrors" in raw && raw.retryClientErrors !== undefined) {
		if (typeof raw.retryClientErrors !== "boolean") {
			fail(`${label}.retryClientErrors must be a boolean`);
		}
		out.retryClientErrors = raw.retryClientErrors;
	}
	return out;
}

function parseModelEntry(raw: unknown, label: string): ModelEntry {
	if (typeof raw === "string") {
		return { model: raw };
	}
	if (!isPlainObject(raw)) {
		fail(`${label} must be a string or an object`);
	}
	if (!("model" in raw) || typeof raw.model !== "string") {
		fail(`${label}.model is required and must be a string`);
	}
	const out: ModelEntry = { model: raw.model };
	if ("priority" in raw && raw.priority !== undefined) {
		if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
			fail(`${label}.priority must be a finite number`);
		}
		out.priority = raw.priority;
	}
	return out;
}

function parseModels(raw: unknown, label: string): Record<string, ModelEntry> {
	if (!isPlainObject(raw)) {
		fail(`${label}.models must be an object`);
	}
	const out: Record<string, ModelEntry> = {};
	for (const [key, value] of Object.entries(raw)) {
		out[key] = parseModelEntry(value, `${label}.models.${key}`);
	}
	return out;
}

function parseProvider(
	key: string,
	raw: unknown,
	order: number,
): ProviderEntry {
	const label = `providers.${key}`;
	if (!isPlainObject(raw)) {
		fail(`${label} must be an object`);
	}

	let provider = key;
	if ("provider" in raw && raw.provider !== undefined) {
		if (typeof raw.provider !== "string" || raw.provider.length === 0) {
			fail(`${label}.provider must be a non-empty string`);
		}
		provider = raw.provider;
	}

	let sdk: SdkKind;
	const isBuiltIn = Object.hasOwn(DEFAULT_SDK_BY_PROVIDER, provider);
	if ("sdk" in raw && raw.sdk !== undefined) {
		sdk = parseSdk(raw.sdk, label);
	} else if (isBuiltIn) {
		// biome-ignore lint/style/noNonNullAssertion: hasOwn-guarded
		sdk = DEFAULT_SDK_BY_PROVIDER[provider]!;
	} else {
		fail(
			`${label}.sdk is required when the resolved provider name ("${provider}") is outside the built-in set (${Object.keys(DEFAULT_SDK_BY_PROVIDER).join(", ")})`,
		);
	}

	let api: ProviderApi | undefined;
	if ("api" in raw && raw.api !== undefined) {
		api = parseApi(raw.api, label);
	} else if (!isBuiltIn) {
		fail(
			`${label}.api is required when the resolved provider name ("${provider}") is outside the built-in set (provide \`api.key\` and/or \`api.endpoint\`)`,
		);
	}

	let priority: number | undefined;
	if ("priority" in raw && raw.priority !== undefined) {
		if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
			fail(`${label}.priority must be a finite number`);
		}
		priority = raw.priority;
	}

	let skills: SkillsConfig | undefined;
	if ("skills" in raw && raw.skills !== undefined) {
		skills = parseSkills(raw.skills, `${label}.skills`);
	}

	let retry: RetryConfig | undefined;
	if ("retry" in raw && raw.retry !== undefined) {
		retry = parseRetry(raw.retry, `${label}.retry`);
	}

	if (!("models" in raw) || raw.models === undefined) {
		fail(`${label}.models is required`);
	}
	const models = parseModels(raw.models, label);

	const entry: ProviderEntry = { key, order, provider, sdk, models };
	if (priority !== undefined) entry.priority = priority;
	if (api !== undefined) entry.api = api;
	if (skills !== undefined) entry.skills = skills;
	if (retry !== undefined) entry.retry = retry;
	return entry;
}

export function validateConfig(input: unknown): Config {
	if (!isPlainObject(input)) {
		fail("config root must be an object");
	}
	let skills: SkillsConfig | undefined;
	if ("skills" in input && input.skills !== undefined) {
		skills = parseSkills(input.skills, "skills");
	}
	let retry: RetryConfig | undefined;
	if ("retry" in input && input.retry !== undefined) {
		retry = parseRetry(input.retry, "retry");
	}
	if (!("providers" in input) || input.providers === undefined) {
		const out: Config = { providers: [] };
		if (skills !== undefined) out.skills = skills;
		if (retry !== undefined) out.retry = retry;
		return out;
	}
	if (!isPlainObject(input.providers)) {
		fail("config.providers must be an object mapping provider keys to entries");
	}
	const providers: ProviderEntry[] = [];
	let order = 0;
	for (const [key, value] of Object.entries(input.providers)) {
		providers.push(parseProvider(key, value, order));
		order += 1;
	}
	const out: Config = { providers };
	if (skills !== undefined) out.skills = skills;
	if (retry !== undefined) out.retry = retry;
	return out;
}
