import type {
	AgentConfig,
	PriorityRule,
	ProviderConfig,
	ScheduleRule,
	Settings,
} from "./types.ts";

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

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") {
		fail(`${label} must be a string`);
	}
	return value;
}

function requireStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) {
		fail(`${label} must be an array of strings`);
	}
	return value.map((v, i) => {
		if (typeof v !== "string") {
			fail(`${label}[${i}] must be a string`);
		}
		return v;
	});
}

function requireStringRecord(
	value: unknown,
	label: string,
): Record<string, string> {
	if (!isPlainObject(value)) {
		fail(`${label} must be an object mapping strings to strings`);
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== "string") {
			fail(`${label}[${JSON.stringify(k)}] must be a string`);
		}
		out[k] = v;
	}
	return out;
}

function parseProvider(
	raw: Record<string, unknown>,
	label: string,
): ProviderConfig {
	// Three states: absent=inferred, null=none, string=explicit.
	if (!("provider" in raw)) {
		return { kind: "inferred" };
	}
	const v = raw.provider;
	if (v === null) return { kind: "none" };
	if (typeof v === "string") return { kind: "explicit", name: v };
	fail(`${label}.provider must be a string or null`);
}

function parseScheduleRule(value: unknown, label: string): ScheduleRule | null {
	if (value === undefined || value === null) return null;
	if (!isPlainObject(value)) {
		fail(`${label} must be an object`);
	}
	const rule: ScheduleRule = {};
	if ("weekdays" in value && value.weekdays !== undefined) {
		rule.weekdays = requireStringArray(value.weekdays, `${label}.weekdays`);
	}
	if ("hours" in value && value.hours !== undefined) {
		rule.hours = requireStringArray(value.hours, `${label}.hours`);
	}
	return rule;
}

function parseRange(s: string): [number, number] | null {
	const idx = s.indexOf("-");
	if (idx < 0) return null;
	const a = s.slice(0, idx);
	const b = s.slice(idx + 1);
	// Require non-empty, all-digit halves so we reject e.g. "1-", "-5", "1-5-7".
	if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return null;
	return [Number(a), Number(b)];
}

function validateScheduleRule(rule: ScheduleRule, label: string): void {
	if (rule.hours !== undefined) {
		if (rule.hours.length === 0) {
			fail(`hours array in ${label} must not be empty`);
		}
		for (const range of rule.hours) {
			const parsed = parseRange(range);
			if (!parsed) {
				fail(`invalid hours range in ${label}: ${JSON.stringify(range)}`);
			}
			const [start, end] = parsed;
			if (start >= end) {
				fail(
					`invalid hours range in ${label} ${JSON.stringify(range)}: start must be less than end`,
				);
			}
			if (end > 48) {
				fail(
					`invalid hours range in ${label} ${JSON.stringify(range)}: end must not exceed 48`,
				);
			}
		}
	}
	if (rule.weekdays !== undefined) {
		if (rule.weekdays.length === 0) {
			fail(`weekdays array in ${label} must not be empty`);
		}
		for (const range of rule.weekdays) {
			const parsed = parseRange(range);
			if (!parsed) {
				fail(`invalid weekdays range in ${label}: ${JSON.stringify(range)}`);
			}
			const [start, end] = parsed;
			if (start > end) {
				fail(
					`invalid weekdays range in ${label} ${JSON.stringify(range)}: start must not exceed end`,
				);
			}
			if (end > 6) {
				fail(
					`invalid weekdays range in ${label} ${JSON.stringify(range)}: end must not exceed 6`,
				);
			}
		}
	}
}

function parseAgent(value: unknown, index: number): AgentConfig {
	const label = `agents[${index}]`;
	if (!isPlainObject(value)) fail(`${label} must be an object`);

	if (!("command" in value) || typeof value.command !== "string") {
		fail(`${label}.command is required and must be a string`);
	}
	const command = value.command;

	const args =
		"args" in value && value.args !== undefined
			? requireStringArray(value.args, `${label}.args`)
			: [];

	let models: Record<string, string> | null = null;
	if (
		"models" in value &&
		value.models !== undefined &&
		value.models !== null
	) {
		models = requireStringRecord(value.models, `${label}.models`);
	}

	let arg_maps: Record<string, string[]> = {};
	if ("arg_maps" in value && value.arg_maps !== undefined) {
		if (!isPlainObject(value.arg_maps)) {
			fail(`${label}.arg_maps must be an object`);
		}
		arg_maps = {};
		for (const [k, v] of Object.entries(value.arg_maps)) {
			arg_maps[k] = requireStringArray(
				v,
				`${label}.arg_maps[${JSON.stringify(k)}]`,
			);
		}
	}

	let env: Record<string, string> | null = null;
	if ("env" in value && value.env !== undefined && value.env !== null) {
		env = requireStringRecord(value.env, `${label}.env`);
	}

	const provider = parseProvider(value, label);

	let openrouter_management_key: string | undefined;
	if (
		"openrouter_management_key" in value &&
		value.openrouter_management_key !== undefined
	) {
		openrouter_management_key = requireString(
			value.openrouter_management_key,
			`${label}.openrouter_management_key`,
		);
	}

	let glm_api_key: string | undefined;
	if ("glm_api_key" in value && value.glm_api_key !== undefined) {
		glm_api_key = requireString(value.glm_api_key, `${label}.glm_api_key`);
	}

	const pre_command =
		"pre_command" in value && value.pre_command !== undefined
			? requireStringArray(value.pre_command, `${label}.pre_command`)
			: [];

	const active = parseScheduleRule(
		"active" in value ? value.active : undefined,
		`${label}.active`,
	);
	const inactive = parseScheduleRule(
		"inactive" in value ? value.inactive : undefined,
		`${label}.inactive`,
	);

	if (active !== null && inactive !== null) {
		fail(
			`agent ${JSON.stringify(command)}: cannot have both active and inactive schedules`,
		);
	}
	if (active !== null) {
		if (active.weekdays === undefined && active.hours === undefined) {
			fail(
				`agent ${JSON.stringify(command)} active schedule: must specify at least one of weekdays or hours`,
			);
		}
		validateScheduleRule(
			active,
			`agent ${JSON.stringify(command)} active schedule`,
		);
	}
	if (inactive !== null) {
		if (inactive.weekdays === undefined && inactive.hours === undefined) {
			fail(
				`agent ${JSON.stringify(command)} inactive schedule: must specify at least one of weekdays or hours`,
			);
		}
		validateScheduleRule(
			inactive,
			`agent ${JSON.stringify(command)} inactive schedule`,
		);
	}

	let sdk: "claude" | "codex" | null | undefined;
	if ("sdk" in value && value.sdk !== undefined) {
		if (value.sdk === null) {
			sdk = null;
		} else if (value.sdk === "claude" || value.sdk === "codex") {
			sdk = value.sdk;
		} else {
			fail(`${label}.sdk must be "claude", "codex", or null`);
		}
	}

	const agent: AgentConfig = {
		command,
		args,
		models,
		arg_maps,
		env,
		provider,
		pre_command,
		active,
		inactive,
	};
	if (openrouter_management_key !== undefined) {
		agent.openrouter_management_key = openrouter_management_key;
	}
	if (glm_api_key !== undefined) {
		agent.glm_api_key = glm_api_key;
	}
	if (sdk !== undefined) {
		agent.sdk = sdk;
	}
	return agent;
}

function parsePriority(value: unknown, index: number): PriorityRule {
	const label = `priority[${index}]`;
	if (!isPlainObject(value)) fail(`${label} must be an object`);

	if (!("command" in value) || typeof value.command !== "string") {
		fail(`${label}.command is required and must be a string`);
	}
	const command = value.command;

	if (
		!("priority" in value) ||
		typeof value.priority !== "number" ||
		!Number.isFinite(value.priority)
	) {
		fail(`${label}.priority is required and must be a number`);
	}
	const priority = value.priority as number;

	const provider = parseProvider(value, label);

	let model: string | null = null;
	if ("model" in value && value.model !== undefined && value.model !== null) {
		model = requireString(value.model, `${label}.model`);
	}

	const rule: PriorityRule = { command, provider, model, priority };

	const scheduleLabel = `priority rule for command ${JSON.stringify(command)}`;
	if ("weekdays" in value && value.weekdays !== undefined) {
		rule.weekdays = requireStringArray(value.weekdays, `${label}.weekdays`);
	}
	if ("hours" in value && value.hours !== undefined) {
		rule.hours = requireStringArray(value.hours, `${label}.hours`);
	}
	validateScheduleRule(
		{ weekdays: rule.weekdays, hours: rule.hours },
		scheduleLabel,
	);

	return rule;
}

export function validateSettings(input: unknown): Settings {
	if (!isPlainObject(input)) {
		fail("settings root must be an object");
	}

	if (!("agents" in input) || !Array.isArray(input.agents)) {
		fail("settings.agents is required and must be an array");
	}
	const agents = input.agents.map((a, i) => parseAgent(a, i));

	let priority: PriorityRule[] = [];
	if ("priority" in input && input.priority !== undefined) {
		if (!Array.isArray(input.priority)) {
			fail("settings.priority must be an array");
		}
		priority = input.priority.map((p, i) => parsePriority(p, i));
	}

	return { agents, priority };
}
