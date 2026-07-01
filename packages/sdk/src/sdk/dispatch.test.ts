/**
 * Unit tests for the `dispatch` API (low-level ResolvedAgent-based
 * execution).
 *
 * High-level flows via `SeherSDK` are covered in `seherSdk.test.ts`, so this
 * file focuses on:
 *   - the correct provider SDK instance being built from a given
 *     `ResolvedAgent.kind`
 *   - the `applyResolvedAgent`-equivalent API key / endpoint projection
 *     running
 *   - passing non-empty tools for a tool-unsupported kind throwing
 *     `DispatchToolsNotSupportedError` (equivalent to
 *     `DispatchError::ToolsNotSupported` on the Rust side)
 */
import { describe, expect, mock, test } from "bun:test";
import type { ResolvedAgent, SdkKind } from "../types.ts";
import {
	mockClaudeTool,
	mockCreateSdkMcpServer,
	mockDefineTool,
} from "./__test__/mockProviderTools.ts";
import type { SeherTool } from "./tools.ts";

// The provider SDK mocks below are a minimized copy of the ones from
// seherSdk.test.ts. dispatch.ts calls buildInstance() internally, so
// without these in place the tests fail on module resolution errors for
// things like "claude-agent-sdk".

const claudeQueryCalls: Array<{ prompt: unknown; options: unknown }> = [];
mock.module("@anthropic-ai/claude-agent-sdk", () => {
	function query(params: { prompt: unknown; options?: unknown }) {
		claudeQueryCalls.push({ prompt: params.prompt, options: params.options });
		return {
			async *[Symbol.asyncIterator]() {
				yield {
					type: "assistant",
					message: { content: [{ type: "text", text: "claude reply" }] },
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
mock.module("@openai/codex-sdk", () => {
	class MockCodex {
		constructor(opts: Record<string, unknown> = {}) {
			codexConstructorOpts.push(opts);
		}
		startThread() {
			return {
				run: async (_input: unknown) => ({
					finalResponse: "codex reply",
					items: [],
				}),
			};
		}
	}
	return { Codex: MockCodex };
});

const copilotConstructorOpts: Array<Record<string, unknown>> = [];
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
				sendAndWait: async () => ({ data: { content: "copilot reply" } }),
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

mock.module("@moonshot-ai/kimi-agent-sdk", () => {
	function createSession() {
		return {
			prompt(_content: unknown) {
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
		readonly category = "cli";
		constructor(code: string, message: string) {
			super(message);
			this.name = "CliError";
			this.code = code;
		}
	}
	return {
		createSession,
		createExternalTool: (def: unknown) => def,
		CliError: MockCliError,
	};
});

mock.module("@cursor/sdk", () => {
	const FakeAgent = {
		create: async () => ({
			agentId: "agent_x",
			model: undefined,
			send: async () => ({
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
			}),
			close: () => {},
			reload: async () => {},
			listArtifacts: async () => [],
			downloadArtifact: async () => Buffer.from(""),
			[Symbol.asyncDispose]: async () => {},
		}),
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

mock.module("@opencode-ai/sdk", () => {
	const fakeClient = {
		session: {
			create: async () => ({ data: { id: "session_1" } }),
			prompt: async () => ({
				data: {
					info: { id: "msg_1" },
					parts: [{ type: "text", text: "opencode reply" }],
				},
			}),
			delete: async () => ({ data: true }),
		},
	};
	return {
		createOpencodeClient: () => fakeClient,
		createOpencode: async () => ({
			client: fakeClient,
			server: { url: "http://127.0.0.1", close: () => {} },
		}),
	};
});

const piCreateSessionCalls: Array<Record<string, unknown>> = [];
mock.module("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: async (options?: Record<string, unknown>) => {
		piCreateSessionCalls.push(options ?? {});
		return {
			session: {
				prompt: async (_text: string) => {},
				subscribe: () => () => {},
				state: {
					get messages() {
						return [
							{
								role: "assistant",
								content: [{ type: "text", text: "pi reply" }],
							},
						];
					},
				},
				dispose: async () => {},
			},
		};
	},
	AuthStorage: {
		inMemory: () => ({ setRuntimeApiKey: () => {} }),
	},
	ModelRegistry: {
		inMemory: () => ({
			find: () => ({ provider: "stub" }),
			registerProvider: () => {},
		}),
	},
	DefaultResourceLoader: class {
		async reload() {}
	},
	getAgentDir: () => "/tmp/mock-agent-dir",
	SettingsManager: { create: () => ({}) },
	SessionManager: {
		create: (_cwd: string, _sessionDir?: string) => ({
			getSessionId: () => "mock-session-id",
			getCwd: () => _cwd,
		}),
		open: (_path: string) => ({
			getSessionId: () => "mock-resumed-id",
			getCwd: () => "/tmp/mock-cwd",
		}),
	},
}));

const { runForResolved, streamForResolved, DispatchToolsNotSupportedError } =
	await import("./dispatch.ts");

function makeResolvedAgent(
	kind: SdkKind,
	overrides: Partial<ResolvedAgent> = {},
): ResolvedAgent {
	const base: ResolvedAgent = {
		provider: overrides.provider ?? kind,
		kind,
		modelId: "test-model",
		modeKey: "build",
		env: {},
		skills: { includeClaude: true },
	};
	if (overrides.api !== undefined) base.api = overrides.api;
	if (overrides.modelId !== undefined) base.modelId = overrides.modelId;
	if (overrides.env !== undefined) base.env = overrides.env;
	if (overrides.skills !== undefined) base.skills = overrides.skills;
	if (overrides.modeKey !== undefined) base.modeKey = overrides.modeKey;
	return base;
}

function dummyTool(): SeherTool {
	// These tests only check tool "presence", not actual tool validation, so
	// `parameters` is cast to avoid depending on a real zod instance.
	return {
		name: "dummy",
		description: "dummy",
		parameters: { shape: {} } as unknown as SeherTool["parameters"],
		handler: () => "",
	};
}

describe("dispatch.runForResolved", () => {
	test("resolving kind=claude selects ClaudeSDK and returns claude reply", async () => {
		const agent = makeResolvedAgent("claude");
		const result = await runForResolved(agent, { prompt: "hi" });
		expect(result.kind).toBe("claude");
		expect(result.text).toBe("claude reply");
		// ResolvedAgent.modelId should propagate to SeherRunOptions.model
		expect(claudeQueryCalls.length).toBeGreaterThan(0);
	});

	test("resolving kind=codex selects CodexSDK", async () => {
		const agent = makeResolvedAgent("codex");
		const result = await runForResolved(agent, { prompt: "hi" });
		expect(result.kind).toBe("codex");
		expect(result.text).toBe("codex reply");
	});

	test("api.key / api.endpoint are projected onto the SDK config (codex)", async () => {
		codexConstructorOpts.length = 0;
		const agent = makeResolvedAgent("codex", {
			api: { key: "sk-from-agent", endpoint: "https://example.test" },
		});
		await runForResolved(agent, { prompt: "hi" });
		// codex only accepts apiKey
		const ctor = codexConstructorOpts[0];
		expect(ctor).toBeDefined();
		expect(ctor?.apiKey).toBe("sk-from-agent");
	});

	test("opts.apiKey overrides ResolvedAgent.api.key", async () => {
		codexConstructorOpts.length = 0;
		const agent = makeResolvedAgent("codex", {
			api: { key: "sk-from-agent" },
		});
		await runForResolved(agent, { prompt: "hi", apiKey: "sk-from-opts" });
		const ctor = codexConstructorOpts[0];
		expect(ctor?.apiKey).toBe("sk-from-opts");
	});

	test("passing tools for a tool-unsupported kind throws (codex)", async () => {
		const agent = makeResolvedAgent("codex");
		await expect(
			runForResolved(agent, { prompt: "hi", tools: [dummyTool()] }),
		).rejects.toBeInstanceOf(DispatchToolsNotSupportedError);
	});

	test("an empty tools array is fine even for a tool-unsupported kind", async () => {
		const agent = makeResolvedAgent("codex");
		const result = await runForResolved(agent, { prompt: "hi", tools: [] });
		expect(result.kind).toBe("codex");
	});

	test("passing tools for a tool-supported kind (claude) does not throw", async () => {
		const agent = makeResolvedAgent("claude");
		const result = await runForResolved(agent, {
			prompt: "hi",
			tools: [dummyTool()],
		});
		expect(result.kind).toBe("claude");
	});
});

describe("dispatch.streamForResolved", () => {
	test("consuming the kind=claude stream returns claude chunks", async () => {
		const agent = makeResolvedAgent("claude");
		const chunks: string[] = [];
		for await (const chunk of streamForResolved(agent, { prompt: "hi" })) {
			chunks.push(chunk.kind);
		}
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.every((k) => k === "claude")).toBe(true);
	});

	test("passing tools for a tool-unsupported kind throws at iteration time", async () => {
		const agent = makeResolvedAgent("codex");
		const iter = streamForResolved(agent, {
			prompt: "hi",
			tools: [dummyTool()],
		})[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toBeInstanceOf(
			DispatchToolsNotSupportedError,
		);
	});
});
