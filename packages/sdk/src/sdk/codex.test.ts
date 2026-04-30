import { beforeEach, describe, expect, mock, test } from "bun:test";

const constructorCalls: Array<Record<string, unknown>> = [];
const startThreadCalls: Array<Record<string, unknown>> = [];
const runCalls: unknown[] = [];

let runResult: unknown = {
	finalResponse: "codex reply",
	items: [],
	usage: null,
};

mock.module("@openai/codex-sdk", () => {
	class MockCodex {
		constructor(opts: Record<string, unknown> = {}) {
			constructorCalls.push(opts);
		}
		startThread(opts: Record<string, unknown> = {}) {
			startThreadCalls.push(opts);
			return {
				run: async (input: unknown) => {
					runCalls.push(input);
					return runResult;
				},
			};
		}
	}
	return { Codex: MockCodex };
});

const { CodexSDK } = await import("./codex.ts");

describe("CodexSDK", () => {
	beforeEach(() => {
		constructorCalls.length = 0;
		startThreadCalls.length = 0;
		runCalls.length = 0;
	});

	test("run forwards prompt and model, returns finalResponse text", async () => {
		runResult = { finalResponse: "hello from codex", items: [], usage: null };

		const sdk = new CodexSDK({ apiKey: "k" });
		const result = await sdk.run({ prompt: "do it", model: "gpt-5-codex" });

		expect(result.kind).toBe("codex");
		expect(result.text).toBe("hello from codex");
		expect(result.raw).toBe(runResult);

		expect(startThreadCalls.length).toBe(1);
		const threadOpts = startThreadCalls[0] as { model?: string };
		expect(threadOpts.model).toBe("gpt-5-codex");
		expect(runCalls).toEqual(["do it"]);
	});

	test("run uses defaultModel when opts.model is missing", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK({ defaultModel: "gpt-5-codex-mini" });
		await sdk.run({ prompt: "p" });
		const threadOpts = startThreadCalls[0] as { model?: string };
		expect(threadOpts.model).toBe("gpt-5-codex-mini");
	});

	test("run omits model when neither provided", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK();
		await sdk.run({ prompt: "p" });
		const threadOpts = startThreadCalls[0] as { model?: string };
		expect(threadOpts.model).toBeUndefined();
	});

	test("systemPrompt is prepended to the prompt input", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK();
		await sdk.run({ prompt: "real prompt", systemPrompt: "system" });
		expect(runCalls[0]).toBe("system\n\nreal prompt");
	});

	test("run falls back to agent_message items when finalResponse is missing", async () => {
		runResult = {
			items: [
				{ type: "reasoning", text: "thinking", id: "r1" },
				{ type: "agent_message", text: "part A", id: "a1" },
				{ type: "agent_message", text: " part B", id: "a2" },
			],
			usage: null,
		};
		const sdk = new CodexSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("part A part B");
	});

	test("run returns empty text when result has neither finalResponse nor items", async () => {
		runResult = {};
		const sdk = new CodexSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("stream yields a single chunk with the full final text", async () => {
		runResult = { finalResponse: "complete text", items: [] };
		const sdk = new CodexSDK();
		const chunks: Array<{ delta: string; kind: string }> = [];
		for await (const chunk of sdk.stream({ prompt: "p" })) {
			chunks.push({ delta: chunk.delta, kind: chunk.kind });
		}
		expect(chunks).toEqual([{ delta: "complete text", kind: "codex" }]);
	});

	test("client is lazily constructed", () => {
		constructorCalls.length = 0;
		new CodexSDK({ apiKey: "k" });
		expect(constructorCalls.length).toBe(0);
	});

	test("apiKey is passed on first use", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK({ apiKey: "secret" });
		await sdk.run({ prompt: "p" });
		expect(constructorCalls.length).toBe(1);
		const opts = constructorCalls[0] as { apiKey?: string };
		expect(opts.apiKey).toBe("secret");
	});
});
