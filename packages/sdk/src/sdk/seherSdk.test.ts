import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentLimit } from "../types.ts";
import { mkConfig } from "./__test__/mkConfig.ts";
import {
	mockClaudeTool,
	mockCreateExternalTool,
	mockCreateSdkMcpServer,
	mockDefineTool,
} from "./__test__/mockProviderTools.ts";

// --- Mock the underlying provider SDKs so no real network calls happen. ---
const claudeQueryCalls: Array<{ prompt: unknown; options: unknown }> = [];
// Side-channel for retry tests: when set to "limit", the next claude.run/stream
// emits a `rate_limit_event` (which the wrapper converts to `LimitError`).
const claudeBehavior: { mode: "success" | "limit" } = { mode: "success" };
mock.module("@anthropic-ai/claude-agent-sdk", () => {
	function query(params: { prompt: unknown; options?: unknown }) {
		claudeQueryCalls.push({ prompt: params.prompt, options: params.options });
		const mode = claudeBehavior.mode;
		return {
			async *[Symbol.asyncIterator]() {
				if (mode === "limit") {
					yield {
						type: "rate_limit_event",
						rate_limit_info: { status: "rejected", resetsAt: 4102444800000 },
						uuid: "u",
						session_id: "s",
					};
					return;
				}
				yield {
					type: "assistant",
					message: { content: [{ type: "text", text: "claude " }] },
					parent_tool_use_id: null,
					uuid: "u",
					session_id: "s",
				};
				yield {
					type: "assistant",
					message: { content: [{ type: "text", text: "stream" }] },
					parent_tool_use_id: null,
					uuid: "u",
					session_id: "s",
				};
				yield {
					type: "result",
					subtype: "success",
					result: "claude reply",
					uuid: "u",
					session_id: "s",
					is_error: false,
					duration_ms: 0,
					duration_api_ms: 0,
					num_turns: 1,
					stop_reason: "end_turn",
					total_cost_usd: 0,
					usage: {},
					modelUsage: {},
					permission_denials: [],
				};
			},
		};
	}
	return {
		query,
		tool: mockClaudeTool,
		createSdkMcpServer: mockCreateSdkMcpServer,
	};
});

const codexConstructorOpts: Array<Record<string, unknown>> = [];
const codexCreates: unknown[] = [];
mock.module("@openai/codex-sdk", () => {
	class MockCodex {
		constructor(opts: Record<string, unknown> = {}) {
			codexConstructorOpts.push(opts);
		}
		startThread() {
			return {
				run: async (input: unknown) => {
					codexCreates.push(input);
					return { finalResponse: "codex reply", items: [] };
				},
			};
		}
	}
	return { Codex: MockCodex };
});

const kimiSessionOpts: Array<Record<string, unknown>> = [];
const kimiPrompts: unknown[] = [];
mock.module("@moonshot-ai/kimi-agent-sdk", () => {
	function createSession(options: Record<string, unknown>) {
		kimiSessionOpts.push(options);
		return {
			prompt(content: unknown) {
				kimiPrompts.push(content);
				const events = [
					{
						type: "ContentPart",
						payload: { type: "text", text: "kimi reply" },
					},
				];
				const result = { status: "finished", steps: 1 };
				return {
					[Symbol.asyncIterator]: async function* () {
						for (const e of events) yield e;
						return result;
					},
					result: Promise.resolve(result),
				};
			},
			close: async () => {},
		};
	}
	class MockCliError extends Error {
		readonly code: string;
		readonly numericCode?: number;
		readonly rawResponse?: string;
		readonly category = "cli";
		constructor(
			code: string,
			message: string,
			numericCode?: number,
			rawResponse?: string,
		) {
			super(message);
			this.name = "CliError";
			this.code = code;
			if (numericCode !== undefined) this.numericCode = numericCode;
			if (rawResponse !== undefined) this.rawResponse = rawResponse;
		}
	}
	return {
		createSession,
		createExternalTool: mockCreateExternalTool,
		CliError: MockCliError,
	};
});

const copilotConstructorOpts: Array<Record<string, unknown>> = [];
const copilotPrompts: unknown[] = [];
mock.module("@github/copilot-sdk", () => {
	class MockCopilotClient {
		constructor(opts: Record<string, unknown> = {}) {
			copilotConstructorOpts.push(opts);
		}
		async start() {}
		async createSession(_config: Record<string, unknown>) {
			return {
				on: () => () => {},
				send: async () => {},
				sendAndWait: async (opts: Record<string, unknown>) => {
					copilotPrompts.push(opts);
					return { data: { content: "copilot reply" } };
				},
				disconnect: async () => {},
			};
		}
	}
	return {
		CopilotClient: MockCopilotClient,
		approveAll: () => {},
		defineTool: mockDefineTool,
	};
});

const opencodeStartCalls: Array<Record<string, unknown>> = [];
const opencodePromptCalls: unknown[] = [];
const opencodeClientOpts: Array<Record<string, unknown>> = [];
mock.module("@opencode-ai/sdk", () => {
	const fakeClient = {
		session: {
			create: async () => ({ data: { id: "session_1" } }),
			prompt: async (opts: unknown) => {
				opencodePromptCalls.push(opts);
				return {
					data: {
						info: { id: "msg_1" },
						parts: [{ type: "text", text: "opencode reply" }],
					},
				};
			},
			delete: async (_opts: unknown) => ({ data: true }),
		},
	};
	return {
		createOpencodeClient: (opts: Record<string, unknown>) => {
			opencodeClientOpts.push(opts);
			return fakeClient;
		},
		createOpencode: async (cfg: Record<string, unknown> = {}) => {
			opencodeStartCalls.push(cfg);
			return {
				client: fakeClient,
				server: { url: "http://127.0.0.1", close: () => {} },
			};
		},
	};
});

const cursorCreateOpts: Array<Record<string, unknown>> = [];
const cursorSendCalls: unknown[] = [];
mock.module("@cursor/sdk", () => {
	const FakeAgent = {
		create: async (options: Record<string, unknown>) => {
			cursorCreateOpts.push(options);
			return {
				agentId: "agent_x",
				model: undefined,
				send: async (message: unknown) => {
					cursorSendCalls.push(message);
					return {
						id: "run_x",
						agentId: "agent_x",
						status: "finished",
						supports: () => true,
						unsupportedReason: () => undefined,
						stream: async function* () {
							yield {
								type: "assistant",
								message: { content: [{ type: "text", text: "cursor reply" }] },
							};
						},
						wait: async () => ({ status: "finished", result: "cursor reply" }),
						cancel: async () => {},
						conversation: async () => [],
						onDidChangeStatus: () => () => {},
					};
				},
				close: () => {},
				reload: async () => {},
				listArtifacts: async () => [],
				downloadArtifact: async () => Buffer.from(""),
				[Symbol.asyncDispose]: async () => {},
			};
		},
	};
	class MockRateLimitError extends Error {
		readonly status = 429;
		constructor(message: string) {
			super(message);
			this.name = "RateLimitError";
		}
	}
	return { Agent: FakeAgent, RateLimitError: MockRateLimitError };
});

const { SeherSDK } = await import("./seherSdk.ts");
const { AllAgentsLimitedError, NoMatchingAgentError } = await import(
	"./resolve.ts"
);
const { LimitError } = await import("./errors.ts");

describe("SeherSDK class", () => {
	beforeEach(() => {
		claudeQueryCalls.length = 0;
		codexConstructorOpts.length = 0;
		codexCreates.length = 0;
		copilotConstructorOpts.length = 0;
		copilotPrompts.length = 0;
		kimiSessionOpts.length = 0;
		kimiPrompts.length = 0;
		opencodeStartCalls.length = 0;
		opencodePromptCalls.length = 0;
		opencodeClientOpts.length = 0;
		cursorCreateOpts.length = 0;
		cursorSendCalls.length = 0;
		claudeBehavior.mode = "success";
	});

	test("kind=claude: synchronous construction, run dispatches to ClaudeSDK", async () => {
		const sdk = new SeherSDK({ kind: "claude", apiKey: "k" });
		expect(sdk.kind).toBe("claude");
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("claude");
		expect(result.text).toBe("claude reply");
		expect(claudeQueryCalls.length).toBe(1);
	});

	test("kind=codex: synchronous construction, run dispatches to CodexSDK", async () => {
		const sdk = new SeherSDK({ kind: "codex", apiKey: "k" });
		expect(sdk.kind).toBe("codex");
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("codex");
		expect(result.text).toBe("codex reply");
		expect(codexCreates.length).toBe(1);
	});

	test("kind=copilot: synchronous construction, run dispatches to CopilotSDK", async () => {
		const sdk = new SeherSDK({ kind: "copilot", gitHubToken: "tok" });
		expect(sdk.kind).toBe("copilot");
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("copilot");
		expect(result.text).toBe("copilot reply");
		expect(copilotPrompts).toEqual([{ prompt: "hi" }]);
	});

	test("auto-resolution selects the highest-priority candidate (build mode)", async () => {
		const config = mkConfig(
			{
				key: "codex",
				order: 0,
				sdk: "codex",
				models: { build: { model: "gpt-5.5", priority: 4 } },
			},
			{
				key: "claude",
				order: 1,
				sdk: "claude",
				priority: 3,
				models: { build: { model: "sonnet" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("codex");
		expect(codexCreates.length).toBe(1);
	});

	test("falls through to next provider when first is limited", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				priority: 5,
				models: { build: { model: "sonnet" } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				priority: 1,
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(async (provider: string): Promise<AgentLimit> => {
			if (provider === "claude") return { kind: "limited", resetTime: reset };
			return { kind: "not_limited" };
		});
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		const { kind, agent } = await sdk.resolved();
		expect(kind).toBe("codex");
		expect(agent?.provider).toBe("codex");
	});

	test("noWait throws AllAgentsLimitedError when all providers limited", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime: reset }),
		);
		const sdk = new SeherSDK({
			noWait: true,
			resolveOverrides: { config, checkLimit },
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toBeInstanceOf(
			AllAgentsLimitedError,
		);
	});

	test("resolved() with explicit kind returns agent: null", async () => {
		const sdk = new SeherSDK({ kind: "claude" });
		const r = await sdk.resolved();
		expect(r.kind).toBe("claude");
		expect(r.agent).toBeNull();
	});

	test("auto-resolution result is cached across run() calls", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			return { kind: "not_limited" };
		});
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi" });
		await sdk.run({ prompt: "again" });
		expect(calls).toBe(1);
	});

	test("reset() forces re-resolution", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			return { kind: "not_limited" };
		});
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi" });
		sdk.reset();
		await sdk.run({ prompt: "again" });
		expect(calls).toBe(2);
	});

	test("kind getter throws before auto-resolution has run", () => {
		const sdk = new SeherSDK();
		expect(() => sdk.kind).toThrow(/not yet resolved/);
	});

	test("stream() with explicit kind=claude yields chunks from ClaudeSDK", async () => {
		const sdk = new SeherSDK({ kind: "claude" });
		const deltas: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			deltas.push(chunk.delta);
			expect(chunk.kind).toBe("claude");
		}
		expect(deltas.join("")).toBe("claude stream");
		expect(claudeQueryCalls.length).toBe(1);
	});

	test("stream() triggers auto-resolution when kind is unset", async () => {
		const config = mkConfig({
			key: "codex",
			order: 0,
			sdk: "codex",
			models: { build: { model: "gpt-5.5" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		const chunks: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			expect(chunk.kind).toBe("codex");
			chunks.push(chunk.delta);
		}
		expect(chunks.join("")).toBe("codex reply");
	});

	test("apiKey is forwarded to ClaudeSDK on explicit kind", async () => {
		const sdk = new SeherSDK({
			kind: "claude",
			apiKey: "claude-key",
			baseURL: "https://example.test",
		});
		await sdk.run({ prompt: "hi" });
		expect(claudeQueryCalls.length).toBe(1);
		const opts = claudeQueryCalls[0]?.options as {
			env?: Record<string, string>;
		};
		expect(opts.env?.ANTHROPIC_API_KEY).toBe("claude-key");
		expect(opts.env?.ANTHROPIC_BASE_URL).toBe("https://example.test");
	});

	test("provider api.key/api.endpoint are forwarded to Claude as ANTHROPIC_API_KEY/BASE_URL", async () => {
		const config = mkConfig({
			key: "zai",
			order: 0,
			sdk: "claude",
			api: { key: "sk-za", endpoint: "https://zai.test" },
			models: { build: { model: "glm-5.1" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi" });
		const opts = claudeQueryCalls[0]?.options as {
			env?: Record<string, string>;
		};
		expect(opts.env?.ANTHROPIC_API_KEY).toBe("sk-za");
		expect(opts.env?.ANTHROPIC_BASE_URL).toBe("https://zai.test");
	});

	test("auto-resolution pins the run model to the resolved modelId", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "claude-sonnet-4-6" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi" });
		const opts = claudeQueryCalls[0]?.options as { model?: string };
		expect(opts.model).toBe("claude-sonnet-4-6");
	});

	test("explicit runOpts.model overrides resolved modelId", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "claude-sonnet-4-6" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi", model: "custom" });
		const opts = claudeQueryCalls[0]?.options as { model?: string };
		expect(opts.model).toBe("custom");
	});

	test("mode=plan picks the model defined under models.plan", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: {
				plan: { model: "claude-opus-4-7" },
				build: { model: "claude-sonnet-4-6" },
			},
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			mode: "plan",
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi" });
		const opts = claudeQueryCalls[0]?.options as { model?: string };
		expect(opts.model).toBe("claude-opus-4-7");
	});

	test("explicit kind=codex with tools warns and ignores tools", async () => {
		const { z } = await import("zod");
		const warnSpy = mock((): void => {});
		const origWarn = console.warn;
		console.warn = warnSpy;
		try {
			const echo = {
				name: "echo",
				description: "Echo",
				parameters: z.object({ msg: z.string() }),
				handler: async ({ msg }: { msg: string }) => msg,
			};
			const sdk = new SeherSDK({ kind: "codex", tools: [echo] });
			await sdk.run({ prompt: "hi" });
			expect(warnSpy.mock.calls.length).toBe(1);
			const msg = String(warnSpy.mock.calls[0]?.[0] ?? "");
			expect(msg).toContain("codex");
			expect(msg).toContain("not supported");
			expect(codexConstructorOpts[0]).not.toHaveProperty("tools");
		} finally {
			console.warn = origWarn;
		}
	});

	test("opencode: api.endpoint becomes baseURL, api.key becomes Authorization header", async () => {
		const config = mkConfig({
			key: "myopencode",
			order: 0,
			sdk: "opencode",
			api: { key: "tok", endpoint: "https://opencode.test" },
			models: { build: { model: "anthropic/claude-sonnet" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi" });
		expect(opencodeClientOpts.length).toBe(1);
		const opts = opencodeClientOpts[0] as {
			baseUrl?: string;
			headers?: Record<string, string>;
		};
		expect(opts.baseUrl).toBe("https://opencode.test");
		expect(opts.headers?.Authorization).toBe("Bearer tok");
	});

	test("LimitError from a provider propagates when retryOnLimit is false", async () => {
		const config = mkConfig({
			key: "claude",
			order: 0,
			sdk: "claude",
			models: { build: { model: "sonnet" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		claudeBehavior.mode = "limit";
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toBeInstanceOf(LimitError);
	});

	test("retryOnLimit falls over to next provider when first hits limit mid-run", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				priority: 9,
				models: { build: { model: "sonnet" } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				priority: 1,
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		claudeBehavior.mode = "limit";
		const onLimitRetry = mock(() => {});
		const sdk = new SeherSDK({
			retryOnLimit: true,
			onLimitRetry,
			resolveOverrides: { config, checkLimit },
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("codex");
		expect(result.text).toBe("codex reply");
		expect(onLimitRetry).toHaveBeenCalledTimes(1);
		const firstCall = onLimitRetry.mock.calls[0]?.[0] as {
			provider: string;
			resetAt?: Date;
		};
		expect(firstCall?.provider).toBe("claude");
		expect(firstCall?.resetAt).toBeInstanceOf(Date);
	});

	test("retryOnLimit + stream(): switches provider mid-stream on LimitError", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				priority: 9,
				models: { build: { model: "sonnet" } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				priority: 1,
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		claudeBehavior.mode = "limit";
		const sdk = new SeherSDK({
			retryOnLimit: true,
			resolveOverrides: { config, checkLimit },
		});
		const chunks: { kind: string; delta: string }[] = [];
		for await (const c of sdk.stream({ prompt: "hi" })) {
			chunks.push({ kind: c.kind, delta: c.delta });
		}
		const codexChunks = chunks.filter((c) => c.kind === "codex");
		expect(codexChunks.length).toBeGreaterThan(0);
		expect(codexChunks.map((c) => c.delta).join("")).toBe("codex reply");
	});

	test("retryOnLimit polls when all providers are limited, recovers, runs", async () => {
		const config = mkConfig(
			{
				key: "claude",
				order: 0,
				sdk: "claude",
				models: { build: { model: "sonnet" } },
			},
			{
				key: "codex",
				order: 1,
				sdk: "codex",
				models: { build: { model: "gpt-5.5" } },
			},
		);
		const reset = new Date("2099-01-01T00:00:00Z");
		let pollCalls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			pollCalls += 1;
			if (pollCalls <= 4) return { kind: "limited", resetTime: reset };
			return { kind: "not_limited" };
		});
		const onAllLimited = mock(() => {});
		const onLimitWaitTick = mock((_n: number) => {});
		const sdk = new SeherSDK({
			retryOnLimit: true,
			limitPollIntervalMs: 5,
			onAllLimited,
			onLimitWaitTick,
			resolveOverrides: { config, checkLimit },
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.text.length).toBeGreaterThan(0);
		expect(onAllLimited).toHaveBeenCalledTimes(1);
		expect(onLimitWaitTick.mock.calls.length).toBeGreaterThan(0);
	});

	test("copilot: api.key becomes gitHubToken, api.endpoint becomes cliUrl", async () => {
		const config = mkConfig({
			key: "copilot",
			order: 0,
			sdk: "copilot",
			api: { key: "gh-tok", endpoint: "https://copilot.test/cli" },
			models: { build: { model: "gpt-5" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: { config, checkLimit },
		});
		await sdk.run({ prompt: "hi" });
		const opts = copilotConstructorOpts[0] as {
			gitHubToken?: string;
			cliUrl?: string;
		};
		expect(opts.gitHubToken).toBe("gh-tok");
		expect(opts.cliUrl).toBe("https://copilot.test/cli");
	});

	test("auto-resolution with tools excludes non-tools-supporting providers", async () => {
		const { z } = await import("zod");
		const echo = {
			name: "echo",
			description: "Echo",
			parameters: z.object({ msg: z.string() }),
			handler: async ({ msg }: { msg: string }) => msg,
		};
		const config = mkConfig(
			{
				key: "codex",
				order: 0,
				sdk: "codex",
				priority: 9,
				models: { build: { model: "gpt-5.5" } },
			},
			{
				key: "claude",
				order: 1,
				sdk: "claude",
				priority: 1,
				models: { build: { model: "sonnet" } },
			},
		);
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			tools: [echo],
			resolveOverrides: { config, checkLimit },
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("claude");
	});

	test("auto-resolution with tools throws when no tools-supporting provider configured", async () => {
		const { z } = await import("zod");
		const echo = {
			name: "echo",
			description: "Echo",
			parameters: z.object({ msg: z.string() }),
			handler: async ({ msg }: { msg: string }) => msg,
		};
		const config = mkConfig({
			key: "codex",
			order: 0,
			sdk: "codex",
			models: { build: { model: "gpt-5.5" } },
		});
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			tools: [echo],
			resolveOverrides: { config, checkLimit },
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toBeInstanceOf(
			NoMatchingAgentError,
		);
	});
});
