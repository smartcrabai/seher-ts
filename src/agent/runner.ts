import { applyArgMaps, resolveArgs } from "./args.ts";
import { buildEnv } from "./env.ts";
import type { AgentConfig } from "./types.ts";

export interface RunAgentOptions {
	model?: string;
	trailingArgs: string[];
	quiet?: boolean;
	env?: Record<string, string | undefined>;
}

export interface RunAgentResult {
	exitCode: number;
}

/**
 * Spawn the agent's child process, optionally running its `pre_command`
 * first. stdin/stdout/stderr are inherited so the agent can interact with
 * the user directly. Resolves with the final exit code (non-zero on
 * failure); throws when spawning itself is impossible.
 */
export async function runAgent(
	agent: AgentConfig,
	opts: RunAgentOptions,
): Promise<RunAgentResult> {
	const baseEnv =
		opts.env ?? (process.env as Record<string, string | undefined>);
	const env = buildEnv(baseEnv, agent.env);

	if (agent.pre_command.length > 0) {
		const [preCmd, ...preArgs] = agent.pre_command;
		if (preCmd === undefined) {
			throw new Error("pre_command is empty after split");
		}
		const pre = Bun.spawn({
			cmd: [preCmd, ...preArgs],
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			env,
		});
		const preExit = await pre.exited;
		if (preExit !== 0) {
			throw new Error(
				`pre_command '${preCmd}' failed with exit code ${preExit}`,
			);
		}
	}

	const resolved = resolveArgs(agent.args, opts.model, agent.models);
	const mapped = applyArgMaps(opts.trailingArgs, agent.arg_maps);
	const cmd = [agent.command, ...resolved, ...mapped];

	if (opts.quiet !== true) {
		console.log(`Executing: ${cmd.join(" ")}`);
	}

	const child = Bun.spawn({
		cmd,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		env,
	});
	const exitCode = await child.exited;
	return { exitCode };
}

/**
 * Decide whether to auto-rerun the agent after a failed invocation.
 * Matches the Rust rule: only provider-aware agents with an explicit
 * provider get a single retry, and only when the first attempt returned
 * a non-zero exit code.
 */
export function shouldAutoRerun(
	exitCode: number,
	hasExplicitProvider: boolean,
): boolean {
	return exitCode !== 0 && hasExplicitProvider;
}
