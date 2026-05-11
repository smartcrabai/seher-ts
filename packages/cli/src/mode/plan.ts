import { SeherSDK } from "@seher-ts/sdk";
import { editPromptInEditor } from "../cli/prompt.ts";
import { streamToStdout, type WriteFn } from "../cli/stream.ts";
import type { Logger } from "../util/logger.ts";
import { applyRetryHooks } from "../util/retry.ts";
import { runBuildMode } from "./build.ts";

const PLAN_SYSTEM_PROMPT = `You are an implementation planner. The user will give you a task. Your job is to produce a clear, step-by-step implementation plan in Markdown.

Strict rules:
- Output ONLY the plan in Markdown. No greetings, no questions, no commentary.
- Do not write or modify any files. Do not call any tools.
- Use sections like "## Goal", "## Approach", "## Steps", "## Risks" as appropriate.
- The plan will be reviewed by the user in an editor and then executed by another agent.`;

const APPROVED_BUILD_TEMPLATE = (plan: string) => `<plan>
${plan}
</plan>

Execute the plan above.`;

export interface PlanModeDeps {
	editPlan?: (initial: string) => Promise<string>;
	createSdk?: (opts: ConstructorParameters<typeof SeherSDK>[0]) => SeherSDK;
}

export interface PlanModeOptions {
	prompt: string;
	provider?: string;
	configPath?: string;
	quiet?: boolean;
	logger: Logger;
	deps?: PlanModeDeps;
	write?: WriteFn;
}

export interface PlanModeResult {
	exitCode: number;
	canceled?: boolean;
	planText?: string;
}

export async function runPlanMode(
	opts: PlanModeOptions,
): Promise<PlanModeResult> {
	const createSdk =
		opts.deps?.createSdk ??
		((sdkOpts: ConstructorParameters<typeof SeherSDK>[0]) =>
			new SeherSDK(sdkOpts));
	const editPlan =
		opts.deps?.editPlan ?? ((seed: string) => editPromptInEditor(seed));

	// 1) Generate the plan with the resolved plan-mode provider.
	const planSdkOpts: ConstructorParameters<typeof SeherSDK>[0] = {
		mode: "plan",
		permissionMode: "bypassPermissions",
	};
	if (opts.provider !== undefined) planSdkOpts.provider = opts.provider;
	if (opts.configPath !== undefined) planSdkOpts.configPath = opts.configPath;
	applyRetryHooks(planSdkOpts, opts.logger);
	const planSdk = createSdk(planSdkOpts);

	if (!opts.quiet) {
		const { kind, agent } = await planSdk.resolved();
		const label =
			agent !== null ? `${agent.provider} (${kind}/${agent.modelId})` : kind;
		opts.logger.info(`Planning with: ${label}`);
	}

	const planOpts: Parameters<typeof streamToStdout>[1] = {
		prompt: opts.prompt,
		systemPrompt: PLAN_SYSTEM_PROMPT,
	};
	if (opts.write !== undefined) planOpts.write = opts.write;
	const planText = await streamToStdout(planSdk, planOpts);

	// 2) Open the plan in the editor for the user to review/edit.
	const edited = (await editPlan(planText)).trim();
	if (edited.length === 0) {
		if (!opts.quiet) opts.logger.info("Plan canceled");
		return { exitCode: 0, canceled: true };
	}

	// 3) Re-resolve under build mode (priority may differ) and stream the build.
	const buildPrompt = APPROVED_BUILD_TEMPLATE(edited);
	const buildSdkOpts: ConstructorParameters<typeof SeherSDK>[0] = {
		mode: "build",
		permissionMode: "bypassPermissions",
	};
	if (opts.provider !== undefined) buildSdkOpts.provider = opts.provider;
	if (opts.configPath !== undefined) buildSdkOpts.configPath = opts.configPath;
	applyRetryHooks(buildSdkOpts, opts.logger);
	const buildSdk = createSdk(buildSdkOpts);

	const buildOpts: Parameters<typeof runBuildMode>[0] = {
		prompt: buildPrompt,
		mode: "build",
		logger: opts.logger,
		sdk: buildSdk,
	};
	if (opts.provider !== undefined) buildOpts.provider = opts.provider;
	if (opts.configPath !== undefined) buildOpts.configPath = opts.configPath;
	if (opts.quiet !== undefined) buildOpts.quiet = opts.quiet;
	if (opts.write !== undefined) buildOpts.write = opts.write;
	const result = await runBuildMode(buildOpts);
	return { exitCode: result.exitCode, planText: edited };
}
