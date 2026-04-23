import { homedir } from "node:os";
import { join } from "node:path";
import { runAgent as runAgentImpl } from "./agent/runner.ts";
import { parseArgs as parseArgsImpl } from "./cli/args.ts";
import { resolvePrompt as resolvePromptImpl } from "./cli/prompt.ts";
import { checkLimit as checkLimitImpl } from "./codexbar/limit.ts";
import { loadSettings as loadSettingsImpl } from "./config/load.ts";
import { filterAgents as filterAgentsImpl } from "./priority/filter.ts";
import { sortByPriority as sortByPriorityImpl } from "./priority/sort.ts";
import { scanCandidates } from "./scan.ts";
import { sleepUntil as sleepUntilImpl } from "./sleep/sleepUntil.ts";
import type {
	AgentConfig,
	AgentStatus,
	PriorityRule,
	ProviderConfig,
} from "./types.ts";
import { startWebServer as startWebServerImpl } from "./web/server.ts";

/**
 * Dependency-injection seam for tests. All collaborators resolve through this
 * object so `runSeher` can be exercised without touching real subprocesses
 * or the filesystem.
 */
export interface RunSeherDeps {
	parseArgs: typeof parseArgsImpl;
	loadSettings: typeof loadSettingsImpl;
	filterAgents: typeof filterAgentsImpl;
	sortByPriority: typeof sortByPriorityImpl;
	checkLimit: typeof checkLimitImpl;
	resolvePrompt: typeof resolvePromptImpl;
	runAgent: typeof runAgentImpl;
	sleepUntil: typeof sleepUntilImpl;
	startWebServer: typeof startWebServerImpl;
	now: () => Date;
	stdout: (line: string) => void;
	stderr: (line: string) => void;
}

const defaultDeps: RunSeherDeps = {
	parseArgs: parseArgsImpl,
	loadSettings: loadSettingsImpl,
	filterAgents: filterAgentsImpl,
	sortByPriority: sortByPriorityImpl,
	checkLimit: checkLimitImpl,
	resolvePrompt: resolvePromptImpl,
	runAgent: runAgentImpl,
	sleepUntil: sleepUntilImpl,
	startWebServer: startWebServerImpl,
	now: () => new Date(),
	stdout: (line) => {
		process.stdout.write(`${line}\n`);
	},
	stderr: (line) => {
		process.stderr.write(`${line}\n`);
	},
};

/** Maximum number of rescan attempts after a `sleepUntil`. Matches Rust behavior. */
const MAX_RESCAN_ATTEMPTS = 1;

export async function runSeher(
	argv: string[],
	overrides: Partial<RunSeherDeps> = {},
): Promise<number> {
	const deps: RunSeherDeps = { ...defaultDeps, ...overrides };
	const args = deps.parseArgs(argv);
	const settings = await deps.loadSettings(args.config);

	if (args.priority) {
		printPriorityOrder(settings.priority, deps.stdout);
		return 0;
	}

	if (args.guiConfig) {
		await deps.startWebServer({
			settingsPath: resolveSettingsPath(args.config),
			openBrowser: true,
		});
		return 0;
	}

	const filtered = deps.filterAgents(settings.agents, {
		command: args.command,
		provider: args.provider,
		model: args.model,
	});

	const sorted = deps.sortByPriority(
		filtered,
		settings.priority,
		args.model ?? null,
		deps.now(),
	);

	if (args.json) {
		const statuses: AgentStatus[] = [];
		for (const agent of sorted) {
			const providerName = resolveProviderName(agent);
			const limit =
				providerName === null
					? ({ kind: "not_limited" } as const)
					: await deps.checkLimit(providerName);
			statuses.push({
				command: agent.command,
				provider: providerName,
				limit,
			});
		}
		deps.stdout(JSON.stringify(statuses, null, 2));
		return 0;
	}

	if (sorted.length === 0) {
		deps.stderr("No agents match the specified filters");
		return 1;
	}

	const prompt = await deps.resolvePrompt({ trailing: args.trailing });
	const trailingArgs =
		args.trailing.length > 0
			? args.trailing
			: prompt !== null && prompt.length > 0
				? [prompt]
				: [];

	let rescans = 0;
	while (true) {
		const scan = await scanCandidates(sorted, async (agent) => {
			const providerName = resolveProviderName(agent);
			if (providerName === null) return { kind: "not_limited" as const };
			return deps.checkLimit(providerName);
		});

		if (scan.kind === "available") {
			const agent = sorted[scan.index];
			if (agent === undefined) {
				deps.stderr("Internal error: scan returned out-of-range index");
				return 1;
			}
			const result = await deps.runAgent(agent, {
				model: args.model,
				trailingArgs,
				quiet: args.quiet,
			});
			return result.exitCode;
		}

		if (scan.kind === "no_agents") {
			deps.stderr("No available agents");
			return 1;
		}

		if (rescans >= MAX_RESCAN_ATTEMPTS) {
			if (!args.quiet) {
				deps.stderr("All agents limited after retry; giving up.");
			}
			return 1;
		}
		if (!args.quiet) {
			deps.stdout(
				`All agents limited. Sleeping until ${scan.minReset.toISOString()}...`,
			);
		}
		await deps.sleepUntil(scan.minReset, { quiet: args.quiet });
		rescans += 1;
	}
}

function resolveProviderName(agent: AgentConfig): string | null {
	switch (agent.provider.kind) {
		case "explicit":
			return agent.provider.name;
		case "inferred":
			return agent.command;
		case "none":
			return null;
	}
}

function providerLabel(provider: ProviderConfig): string {
	switch (provider.kind) {
		case "explicit":
			return provider.name;
		case "inferred":
			return "(inferred)";
		case "none":
			return "(none)";
	}
}

function resolveSettingsPath(explicit: string | undefined): string {
	return explicit ?? join(homedir(), ".config", "seher", "settings.jsonc");
}

function printPriorityOrder(
	rules: PriorityRule[],
	stdout: (line: string) => void,
): void {
	stdout("Priority order:");
	const sorted = [...rules].sort((a, b) => b.priority - a.priority);
	if (sorted.length === 0) {
		stdout("  (no priority rules configured)");
		return;
	}
	for (let i = 0; i < sorted.length; i++) {
		const r = sorted[i];
		if (r === undefined) continue;
		const model = r.model ?? "(none)";
		stdout(
			`  ${i + 1}. [priority=${String(r.priority).padStart(3)}] command=${r.command} provider=${providerLabel(r.provider)} model=${model}`,
		);
	}
}
