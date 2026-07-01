import {
	AllAgentsLimitedError,
	NoMatchingAgentError,
	TimeoutError,
} from "@seher-ts/sdk";
import { type ParsedArgs, parseArgs as parseArgsImpl } from "./cli/args.ts";
import { resolvePrompt as resolvePromptImpl } from "./cli/prompt.ts";
import { runBuildMode as runBuildModeImpl } from "./mode/build.ts";
import { runPlanMode as runPlanModeImpl } from "./mode/plan.ts";
import { runShowResolutionMode as runShowResolutionModeImpl } from "./mode/show-resolution.ts";
import { createLogger } from "./util/logger.ts";

export interface RunSeherDeps {
	parseArgs: typeof parseArgsImpl;
	resolvePrompt: typeof resolvePromptImpl;
	runBuildMode: typeof runBuildModeImpl;
	runPlanMode: typeof runPlanModeImpl;
	runShowResolutionMode: typeof runShowResolutionModeImpl;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

const defaultDeps: RunSeherDeps = {
	parseArgs: parseArgsImpl,
	resolvePrompt: resolvePromptImpl,
	runBuildMode: runBuildModeImpl,
	runPlanMode: runPlanModeImpl,
	runShowResolutionMode: runShowResolutionModeImpl,
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
};

function emitHelpOrVersion(args: ParsedArgs, deps: RunSeherDeps): void {
	if (args.output !== undefined) {
		const text = args.output.endsWith("\n") ? args.output : `${args.output}\n`;
		deps.stdout(text);
	}
}

/**
 * Emits `session: <id>` to stderr for a fresh session (no resume).
 * As in the Rust version's stream.rs, stdout is kept dedicated to assistant
 * text, and the id is sent to stderr so piping with `2>/dev/null` is
 * unaffected. Suppressed when `--quiet` is set (treated as informational).
 */
function emitSessionIdIfFresh(
	args: ParsedArgs,
	sessionId: string | undefined,
	deps: RunSeherDeps,
): void {
	if (args.quiet) return;
	if (args.resume !== undefined) return;
	if (sessionId === undefined || sessionId.length === 0) return;
	deps.stderr(`session: ${sessionId}\n`);
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

	if (args.showResolution) {
		const logger = createLogger({
			quiet: args.quiet,
			stderr: deps.stderr,
		});
		const showOpts: Parameters<typeof runShowResolutionModeImpl>[0] = {
			mode: args.model ?? (args.mode === "plan" ? "plan" : "build"),
			logger,
			stderr: deps.stderr,
			stdout: deps.stdout,
		};
		if (args.provider !== undefined) showOpts.provider = args.provider;
		if (args.config !== undefined) showOpts.configPath = args.config;
		const result = await deps.runShowResolutionMode(showOpts);
		return result.exitCode;
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
			if (args.timeoutMs !== undefined) planOpts.timeoutMs = args.timeoutMs;
			if (args.cwd !== undefined) planOpts.cwd = args.cwd;
			if (args.resume !== undefined) planOpts.resume = args.resume;
			if (args.effortLevel !== undefined)
				planOpts.effortLevel = args.effortLevel;
			const result = await deps.runPlanMode(planOpts);
			emitSessionIdIfFresh(args, result.sessionId, deps);
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
		if (args.timeoutMs !== undefined) buildOpts.timeoutMs = args.timeoutMs;
		if (args.cwd !== undefined) buildOpts.cwd = args.cwd;
		if (args.resume !== undefined) buildOpts.resume = args.resume;
		if (args.effortLevel !== undefined)
			buildOpts.effortLevel = args.effortLevel;
		const result = await deps.runBuildMode(buildOpts);
		emitSessionIdIfFresh(args, result.sessionId, deps);
		return result.exitCode;
	} catch (err) {
		if (
			err instanceof AllAgentsLimitedError ||
			err instanceof NoMatchingAgentError ||
			err instanceof TimeoutError
		) {
			deps.stderr(`${err.message}\n`);
			return 1;
		}
		throw err;
	}
}
