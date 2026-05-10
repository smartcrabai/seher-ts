import type {
	Config,
	ModelEntry,
	ProviderApi,
	ProviderEntry,
	SdkKind,
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
	"codex",
	"copilot",
	"kimi",
	"opencode",
	"cursor",
]);

/** Provider key -> default SDK kind for the six built-in providers. */
const DEFAULT_SDK_BY_PROVIDER: Readonly<Record<string, SdkKind>> = {
	codex: "codex",
	claude: "claude",
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
			`${label}.sdk must be one of "claude", "codex", "copilot", "kimi", "opencode", "cursor"`,
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

	let sdk: SdkKind;
	const isBuiltIn = Object.hasOwn(DEFAULT_SDK_BY_PROVIDER, key);
	if ("sdk" in raw && raw.sdk !== undefined) {
		sdk = parseSdk(raw.sdk, label);
	} else if (isBuiltIn) {
		// biome-ignore lint/style/noNonNullAssertion: hasOwn-guarded
		sdk = DEFAULT_SDK_BY_PROVIDER[key]!;
	} else {
		fail(
			`${label}.sdk is required for provider keys outside the built-in set (${Object.keys(DEFAULT_SDK_BY_PROVIDER).join(", ")})`,
		);
	}

	let api: ProviderApi | undefined;
	if ("api" in raw && raw.api !== undefined) {
		api = parseApi(raw.api, label);
	} else if (!isBuiltIn) {
		fail(
			`${label}.api is required for provider keys outside the built-in set (provide \`api.key\` and/or \`api.endpoint\`)`,
		);
	}

	let priority: number | undefined;
	if ("priority" in raw && raw.priority !== undefined) {
		if (typeof raw.priority !== "number" || !Number.isFinite(raw.priority)) {
			fail(`${label}.priority must be a finite number`);
		}
		priority = raw.priority;
	}

	if (!("models" in raw) || raw.models === undefined) {
		fail(`${label}.models is required`);
	}
	const models = parseModels(raw.models, label);

	const entry: ProviderEntry = { key, order, sdk, models };
	if (priority !== undefined) entry.priority = priority;
	if (api !== undefined) entry.api = api;
	return entry;
}

export function validateConfig(input: unknown): Config {
	if (!isPlainObject(input)) {
		fail("config root must be an object");
	}
	if (!("providers" in input) || input.providers === undefined) {
		return { providers: [] };
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
	return { providers };
}
