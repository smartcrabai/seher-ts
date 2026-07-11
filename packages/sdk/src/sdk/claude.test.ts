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
const { LimitError } = await import("./errors.ts");

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

	test("a recognized `:thinking` suffix is stripped, passing only the base to options.model", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p", model: "claude-opus-4-5:high" });

		expect(lastCall().options.model).toBe("claude-opus-4-5");
	});

	test("an unrecognized suffix like `:free` is passed to options.model unchanged", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({
			prompt: "p",
			model: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
		});

		expect(lastCall().options.model).toBe(
			"openrouter/meta-llama/llama-3.1-8b-instruct:free",
		);
	});

	test("a `:thinking` suffix on defaultModel is also stripped", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({
			defaultModel: "anthropic/claude-opus-4-5:medium",
		});
		await sdk.run({ prompt: "p" });

		expect(lastCall().options.model).toBe("anthropic/claude-opus-4-5");
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

	test("run() throws LimitError on rate_limit_event with status=rejected", async () => {
		const resetMs = 4102444800000;
		queryMessages = [
			{
				type: "rate_limit_event",
				rate_limit_info: { status: "rejected", resetsAt: resetMs },
				uuid: "u",
				session_id: "s",
			},
		];
		const sdk = new ClaudeSDK();
		try {
			await sdk.run({ prompt: "p" });
			throw new Error("expected LimitError");
		} catch (err) {
			expect(err).toBeInstanceOf(LimitError);
			const le = err as InstanceType<typeof LimitError>;
			expect(le.kind).toBe("claude");
			expect(le.resetAt?.getTime()).toBe(resetMs);
		}
	});

	test("rate_limit_event resetsAt in unix seconds is converted to ms", async () => {
		const resetSeconds = 1783196396; // 2026-07-04T20:19:56Z
		queryMessages = [
			{
				type: "rate_limit_event",
				rate_limit_info: { status: "rejected", resetsAt: resetSeconds },
				uuid: "u",
				session_id: "s",
			},
		];
		const sdk = new ClaudeSDK();
		try {
			await sdk.run({ prompt: "p" });
			throw new Error("expected LimitError");
		} catch (err) {
			expect(err).toBeInstanceOf(LimitError);
			const le = err as InstanceType<typeof LimitError>;
			expect(le.resetAt?.getTime()).toBe(resetSeconds * 1000);
		}
	});

	test("rate_limit_event with status=allowed does not throw", async () => {
		queryMessages = [
			{
				type: "rate_limit_event",
				rate_limit_info: { status: "allowed_warning" },
				uuid: "u",
				session_id: "s",
			},
			successResult("normal"),
		];
		const sdk = new ClaudeSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("normal");
	});

	test("stream() throws LimitError mid-stream on rate_limit_event", async () => {
		queryMessages = [
			assistantMessage("partial"),
			{
				type: "rate_limit_event",
				rate_limit_info: { status: "rejected" },
				uuid: "u",
				session_id: "s",
			},
		];
		const sdk = new ClaudeSDK();
		const deltas: string[] = [];
		await expect(
			(async () => {
				for await (const chunk of sdk.stream({ prompt: "p" })) {
					deltas.push(chunk.delta);
				}
			})(),
		).rejects.toBeInstanceOf(LimitError);
		expect(deltas).toEqual(["partial"]);
	});
});

describe("ClaudeSDK effort level", () => {
	beforeEach(() => {
		queryCalls.length = 0;
		queryMessages = [];
	});

	test("a recognized `:high` suffix strips the base and passes it to options.effort", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p", model: "claude-opus-4-5:high" });

		const opts = lastCall().options;
		expect(opts.model).toBe("claude-opus-4-5");
		expect(opts.effort).toBe("high");
	});

	test("a recognized `:max` suffix is passed to options.effort", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p", model: "claude-opus-4-5:max" });

		expect(lastCall().options.effort).toBe("max");
	});

	test("config.effortLevel is used as-is when the model ID has no suffix", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({ effortLevel: "medium" });
		await sdk.run({ prompt: "p", model: "claude-opus-4-5" });

		expect(lastCall().options.effort).toBe("medium");
	});

	test("config.effortLevel takes precedence over a `:level` suffix on the model ID", async () => {
		// Matches the Rust `choose_backend`/resolve precedence: an
		// explicit/config-resolved effort always wins over a model-id suffix.
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({ effortLevel: "medium" });
		await sdk.run({ prompt: "p", model: "claude-opus-4-5:high" });

		const opts = lastCall().options;
		expect(opts.model).toBe("claude-opus-4-5");
		expect(opts.effort).toBe("medium");
	});

	test("a `:level` suffix is used as a fallback when config.effortLevel is unset", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p", model: "claude-opus-4-5:high" });

		expect(lastCall().options.effort).toBe("high");
	});

	test("config.effortLevel applies even with no model specified at all", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK({ effortLevel: "low" });
		await sdk.run({ prompt: "p" });

		expect(lastCall().options.effort).toBe("low");
	});

	test("options.effort is left unset when neither effortLevel nor a suffix is present", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p" });

		expect(lastCall().options.effort).toBeUndefined();
	});

	test("an unrecognized suffix like `:free` does not affect effort and leaves model unchanged", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({
			prompt: "p",
			model: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
		});

		const opts = lastCall().options;
		expect(opts.model).toBe("openrouter/meta-llama/llama-3.1-8b-instruct:free");
		expect(opts.effort).toBeUndefined();
	});

	test("a suffix alias (e.g. `:med`) maps to its closest EffortLevel as a fallback", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p", model: "claude-opus-4-5:med" });

		const opts = lastCall().options;
		expect(opts.model).toBe("claude-opus-4-5");
		expect(opts.effort).toBe("medium");
	});

	test("a `:off` suffix strips the model but has no effort equivalent", async () => {
		queryMessages = [successResult("ok")];
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p", model: "claude-opus-4-5:off" });

		const opts = lastCall().options;
		expect(opts.model).toBe("claude-opus-4-5");
		expect(opts.effort).toBeUndefined();
	});
});
