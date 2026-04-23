import { beforeEach, describe, expect, mock, test } from "bun:test";

const createCalls: Array<Record<string, unknown>> = [];
const streamCalls: Array<Record<string, unknown>> = [];
const constructorCalls: Array<Record<string, unknown>> = [];

let createResponse: unknown = {
	content: [{ type: "text", text: "hello world" }],
};

let streamEvents: unknown[] = [];

mock.module("@anthropic-ai/sdk", () => {
	class MockAnthropic {
		messages: {
			create: (body: Record<string, unknown>) => Promise<unknown>;
			stream: (body: Record<string, unknown>) => AsyncIterable<unknown>;
		};
		constructor(opts: Record<string, unknown> = {}) {
			constructorCalls.push(opts);
			this.messages = {
				create: async (body: Record<string, unknown>) => {
					createCalls.push(body);
					return createResponse;
				},
				stream: (body: Record<string, unknown>) => {
					streamCalls.push(body);
					const events = streamEvents;
					return {
						async *[Symbol.asyncIterator]() {
							for (const e of events) yield e;
						},
					};
				},
			};
		}
	}
	return { default: MockAnthropic };
});

const { ClaudeSDK } = await import("./claude.ts");

describe("ClaudeSDK", () => {
	beforeEach(() => {
		createCalls.length = 0;
		streamCalls.length = 0;
		constructorCalls.length = 0;
	});

	test("run passes model, max_tokens, messages, system to SDK", async () => {
		createResponse = {
			content: [
				{ type: "text", text: "hello " },
				{ type: "text", text: "world" },
				{ type: "tool_use", id: "x" },
			],
		};

		const sdk = new ClaudeSDK({ apiKey: "test-key" });
		const result = await sdk.run({
			prompt: "hi",
			model: "claude-opus-4",
			systemPrompt: "you are helpful",
			maxTokens: 512,
		});

		expect(result.kind).toBe("claude");
		expect(result.text).toBe("hello world");
		expect(result.raw).toBe(createResponse);

		expect(createCalls.length).toBe(1);
		const body = createCalls[0] as {
			model: string;
			max_tokens: number;
			system?: string;
			messages: Array<{ role: string; content: string }>;
		};
		expect(body.model).toBe("claude-opus-4");
		expect(body.max_tokens).toBe(512);
		expect(body.system).toBe("you are helpful");
		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
	});

	test("run uses defaultModel and 1024 max_tokens when not specified", async () => {
		createResponse = { content: [{ type: "text", text: "ok" }] };

		const sdk = new ClaudeSDK({ defaultModel: "claude-haiku-4" });
		const result = await sdk.run({ prompt: "hello" });

		expect(result.text).toBe("ok");
		const body = createCalls[0] as { model: string; max_tokens: number };
		expect(body.model).toBe("claude-haiku-4");
		expect(body.max_tokens).toBe(1024);
	});

	test("run falls back to claude-sonnet-4-6 by default", async () => {
		createResponse = { content: [{ type: "text", text: "x" }] };
		const sdk = new ClaudeSDK();
		await sdk.run({ prompt: "p" });
		const body = createCalls[0] as { model: string };
		expect(body.model).toBe("claude-sonnet-4-6");
	});

	test("run returns empty string when content is not an array", async () => {
		createResponse = { content: null };
		const sdk = new ClaudeSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("stream yields delta chunks for text_delta events", async () => {
		streamEvents = [
			{ type: "message_start" },
			{
				type: "content_block_delta",
				delta: { type: "text_delta", text: "Hel" },
			},
			{
				type: "content_block_delta",
				delta: { type: "text_delta", text: "lo" },
			},
			{
				type: "content_block_delta",
				delta: { type: "input_json_delta", partial_json: "{" },
			},
			{ type: "message_stop" },
		];

		const sdk = new ClaudeSDK();
		const chunks: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			expect(chunk.kind).toBe("claude");
			chunks.push(chunk.delta);
		}
		expect(chunks).toEqual(["", "Hel", "lo", "", ""]);
		expect(streamCalls.length).toBe(1);
	});

	test("client is lazily constructed (not in ctor)", () => {
		constructorCalls.length = 0;
		new ClaudeSDK({ apiKey: "k", baseURL: "https://example.test" });
		expect(constructorCalls.length).toBe(0);
	});

	test("apiKey and baseURL are passed through on first use", async () => {
		createResponse = { content: [{ type: "text", text: "x" }] };
		const sdk = new ClaudeSDK({ apiKey: "my-key", baseURL: "https://b" });
		await sdk.run({ prompt: "p" });
		expect(constructorCalls.length).toBe(1);
		const ctorOpts = constructorCalls[0] as {
			apiKey?: string;
			baseURL?: string;
		};
		expect(ctorOpts.apiKey).toBe("my-key");
		expect(ctorOpts.baseURL).toBe("https://b");
	});
});
