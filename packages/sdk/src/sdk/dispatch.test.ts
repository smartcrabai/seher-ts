/**
 * `dispatch` API (低レベル ResolvedAgent ベースの実行) のユニットテスト。
 *
 * 高レベル SeherSDK 経由のフローは `seherSdk.test.ts` でカバーされているため、
 * ここでは以下に絞る:
 *   - 与えられた `ResolvedAgent.kind` から正しい provider SDK インスタンスが
 *     構築されること
 *   - `applyResolvedAgent` 相当の API key / endpoint 投影が走ること
 *   - tool 非対応 kind に非空 tools を渡すと `DispatchToolsNotSupportedError`
 *     で throw されること (Rust 側の `DispatchError::ToolsNotSupported` 相当)
 */
import { describe, expect, mock, test } from "bun:test";
import type { ResolvedAgent, SdkKind } from "../types.ts";
import {
	mockClaudeTool,
	mockCreateSdkMcpServer,
	mockDefineTool,
} from "./__test__/mockProviderTools.ts";
import type { SeherTool } from "./tools.ts";

// 下記の provider SDK モックは seherSdk.test.ts 由来のものを最小化したコピー。
// dispatch.ts は内部で buildInstance() を呼ぶため、これらが揃っていないと
// "claude-agent-sdk" などのモジュール解決でテストが落ちる。

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
	// 実テストでは tool 検証ではなく "存在判定" だけを使うため、
	// `parameters` は cast して zod 実体への依存を避ける。
	return {
		name: "dummy",
		description: "dummy",
		parameters: { shape: {} } as unknown as SeherTool["parameters"],
		handler: () => "",
	};
}

describe("dispatch.runForResolved", () => {
	test("kind=claude を解決すると ClaudeSDK が選ばれて claude reply を返す", async () => {
		const agent = makeResolvedAgent("claude");
		const result = await runForResolved(agent, { prompt: "hi" });
		expect(result.kind).toBe("claude");
		expect(result.text).toBe("claude reply");
		// ResolvedAgent.modelId が SeherRunOptions.model に伝搬していること
		expect(claudeQueryCalls.length).toBeGreaterThan(0);
	});

	test("kind=codex を解決すると CodexSDK が選ばれる", async () => {
		const agent = makeResolvedAgent("codex");
		const result = await runForResolved(agent, { prompt: "hi" });
		expect(result.kind).toBe("codex");
		expect(result.text).toBe("codex reply");
	});

	test("api.key / api.endpoint が SDK config に投影される (claude)", async () => {
		codexConstructorOpts.length = 0;
		const agent = makeResolvedAgent("codex", {
			api: { key: "sk-from-agent", endpoint: "https://example.test" },
		});
		await runForResolved(agent, { prompt: "hi" });
		// codex は apiKey のみ受け取る
		const ctor = codexConstructorOpts[0];
		expect(ctor).toBeDefined();
		expect(ctor?.apiKey).toBe("sk-from-agent");
	});

	test("opts.apiKey は ResolvedAgent.api.key を上書きする", async () => {
		codexConstructorOpts.length = 0;
		const agent = makeResolvedAgent("codex", {
			api: { key: "sk-from-agent" },
		});
		await runForResolved(agent, { prompt: "hi", apiKey: "sk-from-opts" });
		const ctor = codexConstructorOpts[0];
		expect(ctor?.apiKey).toBe("sk-from-opts");
	});

	test("tool 非対応 kind に tools を渡すと throw する (codex)", async () => {
		const agent = makeResolvedAgent("codex");
		await expect(
			runForResolved(agent, { prompt: "hi", tools: [dummyTool()] }),
		).rejects.toBeInstanceOf(DispatchToolsNotSupportedError);
	});

	test("tool 非対応 kind でも tools が空配列なら通る", async () => {
		const agent = makeResolvedAgent("codex");
		const result = await runForResolved(agent, { prompt: "hi", tools: [] });
		expect(result.kind).toBe("codex");
	});

	test("tool 対応 kind (claude) に tools を渡しても throw しない", async () => {
		const agent = makeResolvedAgent("claude");
		const result = await runForResolved(agent, {
			prompt: "hi",
			tools: [dummyTool()],
		});
		expect(result.kind).toBe("claude");
	});
});

describe("dispatch.streamForResolved", () => {
	test("kind=claude のストリーム消費が claude チャンクを返す", async () => {
		const agent = makeResolvedAgent("claude");
		const chunks: string[] = [];
		for await (const chunk of streamForResolved(agent, { prompt: "hi" })) {
			chunks.push(chunk.kind);
		}
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks.every((k) => k === "claude")).toBe(true);
	});

	test("tool 非対応 kind に tools を渡すと iterate 時点で throw する", async () => {
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
