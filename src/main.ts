import { runAgent as runAgentImpl } from "./_stubs/agent.ts";
import { parseArgs as parseArgsImpl } from "./_stubs/cli.ts";
import { checkLimit as checkLimitImpl } from "./_stubs/codexbar.ts";
import { loadSettings as loadSettingsImpl } from "./_stubs/config.ts";
import {
	filterAgents as filterAgentsImpl,
	sortByPriority as sortByPriorityImpl,
} from "./_stubs/priority.ts";
import { collectPrompt as collectPromptImpl } from "./_stubs/prompt.ts";
import { sleepUntil as sleepUntilImpl } from "./_stubs/sleep.ts";
import type { AgentStatus, PriorityRule } from "./_stubs/types.ts";
import { startWebServer as startWebServerImpl } from "./_stubs/web.ts";
import { scanCandidates } from "./scan.ts";

/**
 * Dependency-injection seam for tests. All collaborators resolve through this
 * object so `runSeher` can be exercised without touching the real stubs.
 */
export interface RunSeherDeps {
	parseArgs: typeof parseArgsImpl;
	loadSettings: typeof loadSettingsImpl;
	filterAgents: typeof filterAgentsImpl;
	sortByPriority: typeof sortByPriorityImpl;
	checkLimit: typeof checkLimitImpl;
	collectPrompt: typeof collectPromptImpl;
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
	collectPrompt: collectPromptImpl,
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
		await deps.startWebServer(settings);
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
		args.model,
		deps.now(),
	);

	if (args.json) {
		const statuses: AgentStatus[] = [];
		for (const agent of sorted) {
			const limit = await deps.checkLimit(agent.provider ?? agent.command);
			statuses.push({
				command: agent.command,
				provider: agent.provider,
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

	const prompt = await deps.collectPrompt(args.trailing);

	let rescans = 0;
	while (true) {
		const scan = await scanCandidates(sorted, (agent) =>
			deps.checkLimit(agent.provider ?? agent.command),
		);

		if (scan.kind === "available") {
			const agent = sorted[scan.index];
			if (agent === undefined) {
				deps.stderr("Internal error: scan returned out-of-range index");
				return 1;
			}
			const result = await deps.runAgent(agent, {
				model: args.model,
				trailingArgs: args.trailing,
				quiet: args.quiet,
				prompt,
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
		const provider = r.provider ?? "(none)";
		stdout(
			`  ${i + 1}. [priority=${String(r.priority).padStart(3)}] command=${r.command} provider=${provider} model=${model}`,
		);
	}
}
