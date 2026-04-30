import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentConfig, AgentLimit, ProviderConfig } from "../types.ts";
import {
	mockClaudeTool,
	mockCreateExternalTool,
	mockCreateSdkMcpServer,
	mockDefineTool,
} from "./__test__/mockProviderTools.ts";

// --- Mock the underlying provider SDKs so no real network calls happen. ---
const claudeQueryCalls: Array<{ prompt: unknown; options: unknown }> = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => {
	function query(params: { prompt: unknown; options?: unknown }) {
		claudeQueryCalls.push({ prompt: params.prompt, options: params.options });
		return {
			async *[Symbol.asyncIterator]() {
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
	return { createSession, createExternalTool: mockCreateExternalTool };
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
		createOpencodeClient: () => fakeClient,
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
	class FakeAgent {
		static async create(options: Record<string, unknown>) {
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
		}
	}
	return { Agent: FakeAgent };
});

const { SeherSDK } = await import("./seherSdk.ts");
const { AllAgentsLimitedError } = await import("./resolve.ts");

const INFERRED: ProviderConfig = { kind: "inferred" };

function mkAgent(
	command: string,
	overrides: Partial<AgentConfig> = {},
): AgentConfig {
	return {
		command,
		args: [],
		models: null,
		arg_maps: {},
		env: null,
		provider: INFERRED,
		pre_command: [],
		active: null,
		inactive: null,
		...overrides,
	};
}

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
		cursorCreateOpts.length = 0;
		cursorSendCalls.length = 0;
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

	test("kind=kimi: synchronous construction, run dispatches to KimiSDK", async () => {
		const sdk = new SeherSDK({ kind: "kimi", workDir: "/tmp/proj" });
		expect(sdk.kind).toBe("kimi");
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("kimi");
		expect(result.text).toBe("kimi reply");
		expect(kimiPrompts).toEqual(["hi"]);
		const opts = kimiSessionOpts[0] as { workDir?: string };
		expect(opts?.workDir).toBe("/tmp/proj");
	});

	test("kind=opencode: synchronous construction, run dispatches to OpencodeSDK", async () => {
		const sdk = new SeherSDK({ kind: "opencode", port: 4096 });
		expect(sdk.kind).toBe("opencode");
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("opencode");
		expect(result.text).toBe("opencode reply");
		expect(opencodeStartCalls.length).toBe(1);
		expect(opencodePromptCalls.length).toBe(1);
	});

	test("kind=cursor: synchronous construction, run dispatches to CursorSDK", async () => {
		const sdk = new SeherSDK({ kind: "cursor", apiKey: "k", cwd: "/tmp/p" });
		expect(sdk.kind).toBe("cursor");
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("cursor");
		expect(result.text).toBe("cursor reply");
		expect(cursorSendCalls).toEqual(["hi"]);
	});

	test("kind unset: resolves to kimi when sdk field is set", async () => {
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("kimi", { sdk: "kimi" })],
				checkLimit,
			},
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("kimi");
	});

	test("kind unset: resolves to copilot when sdk field is set", async () => {
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("copilot", { sdk: "copilot" })],
				checkLimit,
			},
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("copilot");
	});

	test("kind unset: resolves to claude when settings only have a claude agent", async () => {
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("claude", { sdk: "claude" })],
				checkLimit,
			},
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("claude");
	});

	test("kind unset: resolves to codex when claude is limited", async () => {
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(async (provider: string): Promise<AgentLimit> => {
			if (provider === "claude") return { kind: "limited", resetTime: reset };
			return { kind: "not_limited" };
		});
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [
					mkAgent("claude", { sdk: "claude" }),
					mkAgent("codex", { sdk: "codex" }),
				],
				checkLimit,
			},
		});
		const { kind, agent } = await sdk.resolved();
		expect(kind).toBe("codex");
		expect(agent?.command).toBe("codex");
	});

	test("kind unset: noWait throws AllAgentsLimitedError when all limited", async () => {
		const reset = new Date("2099-01-01T00:00:00Z");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "limited", resetTime: reset }),
		);
		const sdk = new SeherSDK({
			noWait: true,
			resolveOverrides: {
				sortedAgents: [mkAgent("claude", { sdk: "claude" })],
				checkLimit,
			},
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
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			return { kind: "not_limited" };
		});
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("claude", { sdk: "claude" })],
				checkLimit,
			},
		});
		await sdk.run({ prompt: "hi" });
		await sdk.run({ prompt: "again" });
		expect(calls).toBe(1);
	});

	test("reset() forces re-resolution", async () => {
		let calls = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			calls += 1;
			return { kind: "not_limited" };
		});
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("claude", { sdk: "claude" })],
				checkLimit,
			},
		});
		await sdk.run({ prompt: "hi" });
		sdk.reset();
		await sdk.run({ prompt: "again" });
		expect(calls).toBe(2);
	});

	test("throws when resolved agent has no sdk field", async () => {
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("claude")], // no sdk field
				checkLimit,
			},
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toThrow(/no `sdk` field/);
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
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("codex", { sdk: "codex" })],
				checkLimit,
			},
		});
		const chunks: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			expect(chunk.kind).toBe("codex");
			chunks.push(chunk.delta);
		}
		expect(chunks.join("")).toBe("codex reply");
		expect(checkLimit).toHaveBeenCalledTimes(1);
	});

	test("re-runs auto-resolution after a failed attempt", async () => {
		let attempt = 0;
		const checkLimit = mock(async (): Promise<AgentLimit> => {
			attempt += 1;
			if (attempt === 1) {
				// scanCandidates catches a throw, leaving the resets list empty,
				// so the resolver throws NoMatchingAgentError.
				throw new Error("transient");
			}
			return { kind: "not_limited" };
		});
		const sdk = new SeherSDK({
			resolveOverrides: {
				sortedAgents: [mkAgent("claude", { sdk: "claude" })],
				checkLimit,
			},
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toThrow();
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("claude");
		expect(attempt).toBe(2);
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

	test("apiKey is forwarded to CodexSDK on auto-resolution", async () => {
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const sdk = new SeherSDK({
			apiKey: "codex-key",
			resolveOverrides: {
				sortedAgents: [mkAgent("codex", { sdk: "codex" })],
				checkLimit,
			},
		});
		await sdk.run({ prompt: "hi" });
		expect(codexConstructorOpts.length).toBe(1);
		expect(codexConstructorOpts[0]).toEqual({ apiKey: "codex-key" });
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
			// CodexSDK constructor receives no `tools` field.
			expect(codexConstructorOpts[0]).not.toHaveProperty("tools");
		} finally {
			console.warn = origWarn;
		}
	});

	test("explicit kind=claude with tools does NOT warn", async () => {
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
			const sdk = new SeherSDK({ kind: "claude", tools: [echo] });
			await sdk.run({ prompt: "hi" });
			expect(warnSpy.mock.calls.length).toBe(0);
			const opts = claudeQueryCalls[0]?.options as {
				mcpServers?: Record<string, unknown>;
			};
			expect(opts.mcpServers?.seher_tools).toBeDefined();
		} finally {
			console.warn = origWarn;
		}
	});

	test("auto-resolution with tools excludes codex/cursor/opencode candidates", async () => {
		const { z } = await import("zod");
		const checkLimit = mock(
			async (): Promise<AgentLimit> => ({ kind: "not_limited" }),
		);
		const echo = {
			name: "echo",
			description: "Echo",
			parameters: z.object({ msg: z.string() }),
			handler: async ({ msg }: { msg: string }) => msg,
		};
		// Higher-priority codex agent is listed first; with tools registered the
		// resolver must skip it and pick claude.
		const sdk = new SeherSDK({
			tools: [echo],
			resolveOverrides: {
				sortedAgents: [
					mkAgent("codex", { sdk: "codex" }),
					mkAgent("cursor", { sdk: "cursor" }),
					mkAgent("opencode", { sdk: "opencode" }),
					mkAgent("claude", { sdk: "claude" }),
				],
				checkLimit,
			},
		});
		const result = await sdk.run({ prompt: "hi" });
		expect(result.kind).toBe("claude");
		expect(claudeQueryCalls.length).toBe(1);
		// codex/cursor/opencode were filtered out before checkLimit was called.
		expect(checkLimit.mock.calls.length).toBe(1);
	});

	test("auto-resolution with tools throws when only no-tool-support agents exist", async () => {
		const { z } = await import("zod");
		const echo = {
			name: "echo",
			description: "Echo",
			parameters: z.object({ msg: z.string() }),
			handler: async ({ msg }: { msg: string }) => msg,
		};
		const sdk = new SeherSDK({
			tools: [echo],
			resolveOverrides: {
				sortedAgents: [
					mkAgent("codex", { sdk: "codex" }),
					mkAgent("cursor", { sdk: "cursor" }),
				],
			},
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toThrow();
	});
});
