import { beforeEach, describe, expect, mock, test } from "bun:test";

const constructorCalls: Array<Record<string, unknown>> = [];
const startThreadCalls: Array<Record<string, unknown>> = [];
const runCalls: unknown[] = [];

let runResult: unknown = {
	finalResponse: "codex reply",
	items: [],
	usage: null,
};

let runShouldThrow: Error | null = null;

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
					if (runShouldThrow !== null) throw runShouldThrow;
					return runResult;
				},
			};
		}
	}
	return { Codex: MockCodex };
});

const { CodexSDK } = await import("./codex.ts");
const { LimitError } = await import("./errors.ts");

describe("CodexSDK", () => {
	beforeEach(() => {
		constructorCalls.length = 0;
		startThreadCalls.length = 0;
		runCalls.length = 0;
		runShouldThrow = null;
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

	test("effortLevel is forwarded as modelReasoningEffort", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK({ effortLevel: "high" });
		await sdk.run({ prompt: "p" });
		const threadOpts = startThreadCalls[0] as {
			modelReasoningEffort?: string;
		};
		expect(threadOpts.modelReasoningEffort).toBe("high");
	});

	test("effortLevel max rounds down to xhigh (Codex has no max tier)", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK({ effortLevel: "max" });
		await sdk.run({ prompt: "p" });
		const threadOpts = startThreadCalls[0] as {
			modelReasoningEffort?: string;
		};
		expect(threadOpts.modelReasoningEffort).toBe("xhigh");
	});

	test("no modelReasoningEffort is set when effortLevel is unset", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK();
		await sdk.run({ prompt: "p" });
		const threadOpts = startThreadCalls[0] as {
			modelReasoningEffort?: string;
		};
		expect(threadOpts.modelReasoningEffort).toBeUndefined();
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

	test("config.env is merged with process.env before being passed to the Codex constructor", async () => {
		runResult = { finalResponse: "x", items: [] };
		const previous = process.env.SEHER_CODEX_ENV_TEST;
		process.env.SEHER_CODEX_ENV_TEST = "from-process";
		try {
			const sdk = new CodexSDK({ env: { FOO: "bar" } });
			await sdk.run({ prompt: "p" });
			const opts = constructorCalls[0] as { env?: Record<string, string> };
			expect(opts.env?.FOO).toBe("bar");
			expect(opts.env?.SEHER_CODEX_ENV_TEST).toBe("from-process");
		} finally {
			if (previous === undefined) {
				delete process.env.SEHER_CODEX_ENV_TEST;
			} else {
				process.env.SEHER_CODEX_ENV_TEST = previous;
			}
		}
	});

	test("no env key is set on Codex options when config.env is empty/unset", async () => {
		runResult = { finalResponse: "x", items: [] };
		const sdk = new CodexSDK();
		await sdk.run({ prompt: "p" });
		const opts = constructorCalls[0] as { env?: Record<string, string> };
		expect(opts.env).toBeUndefined();

		const sdkWithEmptyEnv = new CodexSDK({ env: {} });
		await sdkWithEmptyEnv.run({ prompt: "p" });
		const opts2 = constructorCalls[1] as { env?: Record<string, string> };
		expect(opts2.env).toBeUndefined();
	});

	test("run() converts rate-limit error message into LimitError", async () => {
		runShouldThrow = new Error(
			"openai: 429 too many requests; rate_limit_exceeded",
		);
		const sdk = new CodexSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toBeInstanceOf(LimitError);
	});

	test("run() passes through non-limit errors unchanged", async () => {
		const err = new Error("internal server error");
		runShouldThrow = err;
		const sdk = new CodexSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toBe(err);
	});

	test("run() passes through a bare '429' with no HTTP context or limit phrase unchanged", async () => {
		// A standalone "429" (a request id, a byte count, ...) with no "HTTP"
		// context and no rate/usage-limit phrase must not be misclassified as
		// a rate limit.
		const err = new Error("request 429 of 1000 completed");
		runShouldThrow = err;
		const sdk = new CodexSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toBe(err);
	});

	test("run() converts an 'HTTP 429' error with no other limit phrase to LimitError", async () => {
		runShouldThrow = new Error("OpenAI API error (HTTP 429): server busy");
		const sdk = new CodexSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toBeInstanceOf(LimitError);
	});

	test("run() passes through 'HTTP 4290' (trailing digit) unchanged", async () => {
		// "HTTP 4290" is a different status code and must not match "HTTP 429".
		const err = new Error("OpenAI API error (HTTP 4290): oversized");
		runShouldThrow = err;
		const sdk = new CodexSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toBe(err);
	});
});
