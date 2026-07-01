import { type EffortLevel, SeherSDK } from "@seher-ts/sdk";
import { editPromptInEditor, ensureEditorAvailable } from "../cli/prompt.ts";
import type { WriteFn } from "../cli/stream.ts";
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
	/**
	 * エディタを起動できる環境かを確認するための差し替え可能なフック。
	 * 既定では `ensureEditorAvailable` をそのまま使う。テストで TTY の
	 * 有無を制御するために差し替えられる。
	 */
	ensureEditorAvailable?: () => void;
}

export interface PlanModeOptions {
	prompt: string;
	provider?: string;
	configPath?: string;
	timeoutMs?: number;
	effortLevel?: EffortLevel;
	quiet?: boolean;
	/** Canonicalized working directory; forwarded to both plan and build SDKs. */
	cwd?: string;
	/**
	 * Session id to resume. Plan generation always starts a fresh transcript
	 * (planning is a single-shot dry run by design), but the build phase
	 * forwards `resume` to the underlying SDK so subsequent plan-mode runs can
	 * continue an existing build transcript.
	 */
	resume?: string;
	logger: Logger;
	deps?: PlanModeDeps;
	write?: WriteFn;
}

export interface PlanModeResult {
	exitCode: number;
	canceled?: boolean;
	planText?: string;
	/** Session id reported by the build phase, when supported. */
	sessionId?: string;
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
	const ensureEditor =
		opts.deps?.ensureEditorAvailable ?? ensureEditorAvailable;

	// プラン生成のコストを払う前に、エディタを安全に開けるかをまず確認し
	// 失敗時は即座にエラーにする (Rust 版の `seher plan` と同じ挙動)。
	// CLI UX 上はスタックトレースを出さず、メッセージのみ stderr に出して
	// exit 1 で終了する。
	try {
		ensureEditor();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		opts.logger.error(msg);
		return { exitCode: 1 };
	}

	// 1) プランを生成する。Rust 側の StreamOutput::CaptureOnly に合わせて
	//    stdout には流さず、生成結果をそのままエディタに seed として渡す。
	const planSdkOpts: ConstructorParameters<typeof SeherSDK>[0] = {
		mode: "plan",
		permissionMode: "bypassPermissions",
	};
	if (opts.provider !== undefined) planSdkOpts.provider = opts.provider;
	if (opts.configPath !== undefined) planSdkOpts.configPath = opts.configPath;
	if (opts.timeoutMs !== undefined) planSdkOpts.timeoutMs = opts.timeoutMs;
	if (opts.cwd !== undefined) planSdkOpts.cwd = opts.cwd;
	if (opts.effortLevel !== undefined)
		planSdkOpts.effortLevel = opts.effortLevel;
	applyRetryHooks(planSdkOpts, opts.logger);
	const planSdk = createSdk(planSdkOpts);

	if (!opts.quiet) {
		const { kind, agent } = await planSdk.resolved();
		const label =
			agent !== null ? `${agent.provider} (${kind}/${agent.modelId})` : kind;
		opts.logger.info(`Planning with: ${label}`);
	}

	const runOpts: {
		prompt: string;
		systemPrompt: string;
		timeoutMs?: number;
	} = {
		prompt: opts.prompt,
		systemPrompt: PLAN_SYSTEM_PROMPT,
	};
	if (opts.timeoutMs !== undefined) runOpts.timeoutMs = opts.timeoutMs;
	const planResult = await planSdk.run(runOpts);
	const planText = planResult.text;

	// 2) 生成したプランをエディタで開いてレビュー/編集してもらう。
	const edited = (await editPlan(planText)).trim();
	if (edited.length === 0) {
		if (!opts.quiet) opts.logger.info("Plan canceled");
		return { exitCode: 0, canceled: true };
	}

	// 3) build モードで再解決して、承認されたプランを実行する。
	const buildPrompt = APPROVED_BUILD_TEMPLATE(edited);
	const buildSdkOpts: ConstructorParameters<typeof SeherSDK>[0] = {
		mode: "build",
		permissionMode: "bypassPermissions",
	};
	if (opts.provider !== undefined) buildSdkOpts.provider = opts.provider;
	if (opts.configPath !== undefined) buildSdkOpts.configPath = opts.configPath;
	if (opts.timeoutMs !== undefined) buildSdkOpts.timeoutMs = opts.timeoutMs;
	if (opts.cwd !== undefined) buildSdkOpts.cwd = opts.cwd;
	if (opts.effortLevel !== undefined)
		buildSdkOpts.effortLevel = opts.effortLevel;
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
	if (opts.timeoutMs !== undefined) buildOpts.timeoutMs = opts.timeoutMs;
	if (opts.cwd !== undefined) buildOpts.cwd = opts.cwd;
	if (opts.resume !== undefined) buildOpts.resume = opts.resume;
	if (opts.quiet !== undefined) buildOpts.quiet = opts.quiet;
	if (opts.write !== undefined) buildOpts.write = opts.write;
	const result = await runBuildMode(buildOpts);
	const out: PlanModeResult = { exitCode: result.exitCode, planText: edited };
	if (result.sessionId !== undefined) out.sessionId = result.sessionId;
	return out;
}
