import {
	AllAgentsLimitedError,
	type BuildCandidatesOptions,
	buildCandidates,
	type Candidate,
	type Config,
	checkLimit as checkLimitImpl,
	codexbarProviderName,
	loadConfig as loadConfigImpl,
	NoMatchingAgentError,
	resolveAgent as resolveAgentImpl,
} from "@seher-ts/sdk";
import type { Logger } from "../util/logger.ts";

export interface ShowResolutionOptions {
	/** mode key (e.g. "plan", "build", "low", ...). */
	mode: string;
	/** provider key specified via `-p`. */
	provider?: string;
	/** YAML path specified via `-c`. */
	configPath?: string;
	logger: Logger;
	stderr: (text: string) => void;
	stdout: (text: string) => void;
	/** Override for tests. */
	loadConfig?: typeof loadConfigImpl;
	checkLimit?: typeof checkLimitImpl;
	resolveAgent?: typeof resolveAgentImpl;
}

export interface ShowResolutionResult {
	exitCode: number;
}

/**
 * Formats as `YYYY-MM-DD HH:MM TZ` using `Intl.DateTimeFormat`.
 * This matches the Rust side's `chrono::Local.format("%Y-%m-%d %H:%M %Z")`.
 */
function formatResetTime(date: Date): string {
	const dtf = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		timeZoneName: "short",
	});
	const parts = dtf.formatToParts(date);
	const get = (type: Intl.DateTimeFormatPartTypes): string => {
		const found = parts.find((p) => p.type === type);
		return found ? found.value : "";
	};
	const year = get("year");
	const month = get("month");
	const day = get("day");
	let hour = get("hour");
	if (hour === "24") hour = "00"; // safeguard for environments where hour12: false yields 24
	const minute = get("minute");
	const tz = get("timeZoneName");
	return `${year}-${month}-${day} ${hour}:${minute} ${tz}`;
}

interface CandidateLimitTag {
	tag: string;
}

async function probeLimitTag(
	candidate: Candidate,
	checkLimit: typeof checkLimitImpl,
): Promise<CandidateLimitTag> {
	const codexbarName = codexbarProviderName(
		candidate.resolved.kind,
		candidate.provider,
	);
	try {
		const limit = await checkLimit(codexbarName);
		if (limit.kind === "limited") {
			return { tag: ` [LIMITED until ${formatResetTime(limit.resetTime)}]` };
		}
		return { tag: "" };
	} catch {
		// As on the Rust side, any error during the probe (codexbar
		// missing, malformed JSON, process spawn failure, etc.) is
		// displayed as `[probe error]`.
		return { tag: " [probe error]" };
	}
}

export async function runShowResolutionMode(
	opts: ShowResolutionOptions,
): Promise<ShowResolutionResult> {
	const loadConfig = opts.loadConfig ?? loadConfigImpl;
	const checkLimit = opts.checkLimit ?? checkLimitImpl;
	const resolveAgent = opts.resolveAgent ?? resolveAgentImpl;

	let config: Config;
	try {
		config = await loadConfig(opts.configPath);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		opts.stderr(`${message}\n`);
		return { exitCode: 1 };
	}

	const buildOpts: BuildCandidatesOptions = { modeKey: opts.mode };
	if (opts.provider !== undefined) buildOpts.providerFilter = opts.provider;
	const candidates = buildCandidates(config, buildOpts);

	if (candidates.length === 0) {
		opts.stderr(`No candidates for mode key '${opts.mode}'\n`);
	} else {
		opts.stderr(`Candidates (mode=${opts.mode}):\n`);
		// Probe each candidate's limit status in parallel.
		const tags = await Promise.all(
			candidates.map((c) => probeLimitTag(c, checkLimit)),
		);
		for (let i = 0; i < candidates.length; i++) {
			const c = candidates[i];
			const tag = tags[i];
			if (c === undefined || tag === undefined) continue;
			const effortSuffix =
				c.resolved.effort !== undefined ? `, effort=${c.resolved.effort}` : "";
			opts.stderr(
				`  ${i}. ${c.resolved.provider} (sdk=${c.resolved.kind}, model=${c.resolved.modelId}, priority=${c.priority}${effortSuffix})${tag.tag}\n`,
			);
		}
		opts.stderr("\n");
	}

	// Resolve the winner. Called even with zero candidates so we can catch
	// NoMatchingAgentError. configPath is unnecessary since we pass the
	// already-loaded config.
	try {
		const agent = await resolveAgent({
			modeKey: opts.mode,
			...(opts.provider !== undefined && { provider: opts.provider }),
			config,
			noWait: true,
			checkLimit,
		});
		const winner: {
			provider: string;
			model: string;
			sdk: string;
			mode: string;
			effort?: string;
		} = {
			provider: agent.provider,
			model: agent.modelId,
			sdk: agent.kind,
			mode: agent.modeKey,
		};
		if (agent.effort !== undefined) winner.effort = agent.effort;
		opts.stdout(`${JSON.stringify(winner)}\n`);
		return { exitCode: 0 };
	} catch (err) {
		if (
			err instanceof AllAgentsLimitedError ||
			err instanceof NoMatchingAgentError
		) {
			opts.stderr(`${err.message}\n`);
			return { exitCode: 1 };
		}
		throw err;
	}
}
