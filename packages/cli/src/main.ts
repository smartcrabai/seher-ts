import { AllAgentsLimitedError, NoMatchingAgentError } from "@seher-ts/sdk";
import { type ParsedArgs, parseArgs as parseArgsImpl } from "./cli/args.ts";
import { resolvePrompt as resolvePromptImpl } from "./cli/prompt.ts";
import { runBuildMode as runBuildModeImpl } from "./mode/build.ts";
import { runPlanMode as runPlanModeImpl } from "./mode/plan.ts";
import { createLogger } from "./util/logger.ts";

export interface RunSeherDeps {
	parseArgs: typeof parseArgsImpl;
	resolvePrompt: typeof resolvePromptImpl;
	runBuildMode: typeof runBuildModeImpl;
	runPlanMode: typeof runPlanModeImpl;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

const defaultDeps: RunSeherDeps = {
	parseArgs: parseArgsImpl,
	resolvePrompt: resolvePromptImpl,
	runBuildMode: runBuildModeImpl,
	runPlanMode: runPlanModeImpl,
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

function emitHelpOrVersion(args: ParsedArgs, deps: RunSeherDeps): void {
	if (args.output !== undefined) {
		const text = args.output.endsWith("\n") ? args.output : `${args.output}\n`;
		deps.stdout(text);
	}
}

export async function runSeher(
	argv: string[],
	overrides: Partial<RunSeherDeps> = {},
): Promise<number> {
	const deps: RunSeherDeps = { ...defaultDeps, ...overrides };
	const args = deps.parseArgs(argv);

	if (args.help || args.version) {
		emitHelpOrVersion(args, deps);
		return 0;
	}

	const prompt = await deps.resolvePrompt({ trailing: args.trailing });
	if (prompt === null || prompt.length === 0) {
		deps.stderr("Empty prompt; nothing to do.\n");
		return 1;
	}

	const logger = createLogger({
		quiet: args.quiet,
		stderr: deps.stderr,
	});

	try {
		if (args.mode === "plan") {
			const planOpts: Parameters<typeof runPlanModeImpl>[0] = {
				prompt,
				logger,
				quiet: args.quiet,
			};
			if (args.provider !== undefined) planOpts.provider = args.provider;
			if (args.config !== undefined) planOpts.configPath = args.config;
			const result = await deps.runPlanMode(planOpts);
			return result.exitCode;
		}
		const buildOpts: Parameters<typeof runBuildModeImpl>[0] = {
			prompt,
			logger,
			quiet: args.quiet,
		};
		if (args.provider !== undefined) buildOpts.provider = args.provider;
		if (args.model !== undefined) buildOpts.mode = args.model;
		if (args.config !== undefined) buildOpts.configPath = args.config;
		const result = await deps.runBuildMode(buildOpts);
		return result.exitCode;
	} catch (err) {
		if (
			err instanceof AllAgentsLimitedError ||
			err instanceof NoMatchingAgentError
		) {
			deps.stderr(`${err.message}\n`);
			return 1;
		}
		throw err;
	}
}
