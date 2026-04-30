import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
	mockClaudeTool,
	mockCreateSdkMcpServer,
} from "./__test__/mockProviderTools.ts";

const queryCalls: Array<{ prompt: unknown; options: Record<string, unknown> }> =
	[];
let queryMessages: unknown[] = [];

mock.module("@anthropic-ai/claude-agent-sdk", () => {
	function query(params: {
		prompt: unknown;
		options?: Record<string, unknown>;
	}) {
		queryCalls.push({ prompt: params.prompt, options: params.options ?? {} });
		const messages = queryMessages;
		return {
			async *[Symbol.asyncIterator]() {
				for (const m of messages) yield m;
			},
		};
	}
	return {
		query,
		tool: mockClaudeTool,
		createSdkMcpServer: mockCreateSdkMcpServer,
	};
});

const { ClaudeSDK } = await import("./claude.ts");

function successResult(text: string) {
	return {
		type: "result",
		subtype: "success",
		result: text,
		uuid: "u",
		session_id: "s",
		duration_ms: 0,
		duration_api_ms: 0,
		is_error: false,
		num_turns: 1,
		stop_reason: "end_turn",
		total_cost_usd: 0,
		usage: {},
		modelUsage: {},
		permission_denials: [],
	};
}

function assistantMessage(text: string) {
	return {
		type: "assistant",
		message: { content: [{ type: "text", text }] },
		parent_tool_use_id: null,
		uuid: "u",
		session_id: "s",
	};
}

function lastCall() {
	const call = queryCalls.at(-1);
	if (call === undefined) throw new Error("no query call recorded");
	return call;
}

describe("ClaudeSDK", () => {
	beforeEach(() => {
		queryCalls.length = 0;
		queryMessages = [];
	});

	test("run forwards prompt and returns the success result text", async () => {
		queryMessages = [assistantMessage("partial"), successResult("hello world")];

		const sdk = new ClaudeSDK({ apiKey: "test-key" });
		const result = await sdk.run({
			prompt: "hi",
			model: "claude-opus-4",
			systemPrompt: "you are helpful",
		});

		expect(result.kind).toBe("claude");
		expect(result.text).toBe("hello world");
		expect(queryCalls.length).toBe(1);

		const call = lastCall();
		expect(call.prompt).toBe("hi");
		expect(call.options.model).toBe("claude-opus-4");
		expect(call.options.systemPrompt).toBe("you are helpful");
	});

	test("run defaults permissionMode to auto without the dangerous-skip flag", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p" });

		const opts = lastCall().options;
		expect(opts.permissionMode).toBe("auto");
		expect(opts.allowDangerouslySkipPermissions).toBeUndefined();
	});

	test("bypassPermissions override sets the dangerous-skip flag", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({ permissionMode: "bypassPermissions" });
		await sdk.run({ prompt: "p" });

		const opts = lastCall().options;
		expect(opts.permissionMode).toBe("bypassPermissions");
		expect(opts.allowDangerouslySkipPermissions).toBe(true);
	});

	test("run uses defaultModel when opts.model is missing", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({ defaultModel: "claude-haiku-4" });
		await sdk.run({ prompt: "hello" });

		expect(lastCall().options.model).toBe("claude-haiku-4");
	});

	test("run omits model when neither provided", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p" });

		expect(lastCall().options.model).toBeUndefined();
	});

	test("apiKey and baseURL are forwarded as env vars", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({ apiKey: "my-key", baseURL: "https://b" });
		await sdk.run({ prompt: "p" });

		const env = lastCall().options.env as Record<string, string>;
		expect(env.ANTHROPIC_API_KEY).toBe("my-key");
		expect(env.ANTHROPIC_BASE_URL).toBe("https://b");
	});

	test("run returns empty string when no result message arrives", async () => {
		queryMessages = [assistantMessage("ignored")];
		const sdk = new ClaudeSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("run returns empty string for an error result", async () => {
		queryMessages = [
			{
				type: "result",
				subtype: "error_during_execution",
				uuid: "u",
				session_id: "s",
				is_error: true,
				duration_ms: 0,
				duration_api_ms: 0,
				num_turns: 0,
				stop_reason: null,
				total_cost_usd: 0,
				usage: {},
				modelUsage: {},
				permission_denials: [],
				errors: ["boom"],
			},
		];
		const sdk = new ClaudeSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("stream yields delta chunks for assistant text content", async () => {
		queryMessages = [
			assistantMessage("Hel"),
			assistantMessage("lo"),
			successResult("Hello"),
		];

		const sdk = new ClaudeSDK();
		const deltas: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			expect(chunk.kind).toBe("claude");
			deltas.push(chunk.delta);
		}
		expect(deltas).toEqual(["Hel", "lo"]);
	});

	test("tools are forwarded as an SDK MCP server in mcpServers", async () => {
		const { z } = await import("zod");
		queryMessages = [successResult("ok")];

		const echo = {
			name: "echo",
			description: "Echo input",
			parameters: z.object({ msg: z.string() }),
			handler: async ({ msg }: { msg: string }) => `echoed: ${msg}`,
		};
		const sdk = new ClaudeSDK({ tools: [echo] });
		await sdk.run({ prompt: "p" });

		const opts = lastCall().options;
		const mcpServers = opts.mcpServers as Record<
			string,
			Record<string, unknown>
		>;
		expect(mcpServers).toBeDefined();
		expect(mcpServers.seher_tools).toBeDefined();
		expect(mcpServers.seher_tools.__seherSdkMcp).toBe(true);
		expect(mcpServers.seher_tools.name).toBe("seher_tools");
		const mcpTools = mcpServers.seher_tools.tools as Array<{
			__seherToolDef: boolean;
			name: string;
			description: string;
		}>;
		expect(mcpTools.length).toBe(1);
		expect(mcpTools[0]?.name).toBe("echo");
		expect(mcpTools[0]?.description).toBe("Echo input");
	});

	test("empty tools array does not set mcpServers", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({ tools: [] });
		await sdk.run({ prompt: "p" });
		expect(lastCall().options.mcpServers).toBeUndefined();
	});
});
