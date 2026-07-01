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
	/** mode key (例: "plan", "build", "low" ...)。 */
	mode: string;
	/** `-p` で指定された provider key。 */
	provider?: string;
	/** `-c` で指定された YAML パス。 */
	configPath?: string;
	logger: Logger;
	stderr: (text: string) => void;
	stdout: (text: string) => void;
	/** テスト用 override。 */
	loadConfig?: typeof loadConfigImpl;
	checkLimit?: typeof checkLimitImpl;
	resolveAgent?: typeof resolveAgentImpl;
}

export interface ShowResolutionResult {
	exitCode: number;
}

/**
 * `Intl.DateTimeFormat` を使って `YYYY-MM-DD HH:MM TZ` 形式で整形する。
 * Rust 側の `chrono::Local.format("%Y-%m-%d %H:%M %Z")` と揃える。
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
	if (hour === "24") hour = "00"; // hour12: false で 24 が出る環境への保険
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
		// Rust 側と同様、probe で発生したあらゆるエラー (codexbar 不在、JSON 不正、
		// プロセス起動失敗など) は `[probe error]` として表示する。
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
		// 候補ごとの limit 状態を並列で probe する。
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

	// winner 解決。候補ゼロでも NoMatchingAgentError を捕まえるために呼ぶ。
	// 既に loadConfig を呼んだ結果を渡すので configPath は不要。
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
