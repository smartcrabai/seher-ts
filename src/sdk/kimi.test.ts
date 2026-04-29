import { beforeEach, describe, expect, mock, test } from "bun:test";

const createSessionCalls: Array<Record<string, unknown>> = [];
const promptCalls: unknown[] = [];
const closeCalls: number[] = [];

let streamEvents: unknown[] = [];
let runResult: unknown = { status: "finished", steps: 1 };

mock.module("@moonshot-ai/kimi-agent-sdk", () => {
	function createSession(options: Record<string, unknown>) {
		createSessionCalls.push(options);
		return {
			prompt(content: unknown) {
				promptCalls.push(content);
				const events = streamEvents;
				const result = runResult;
				return {
					[Symbol.asyncIterator]: async function* () {
						for (const e of events) yield e;
						return result;
					},
					result: Promise.resolve(result),
				};
			},
			close: async () => {
				closeCalls.push(1);
			},
		};
	}
	return { createSession };
});

const { KimiSDK } = await import("./kimi.ts");

describe("KimiSDK", () => {
	beforeEach(() => {
		createSessionCalls.length = 0;
		promptCalls.length = 0;
		closeCalls.length = 0;
		streamEvents = [];
		runResult = { status: "finished", steps: 1 };
	});

	test("run forwards prompt and model, joins ContentPart text events", async () => {
		streamEvents = [
			{ type: "TurnBegin", payload: {} },
			{ type: "ContentPart", payload: { type: "text", text: "hello " } },
			{ type: "ContentPart", payload: { type: "think", think: "..." } },
			{ type: "ContentPart", payload: { type: "text", text: "kimi" } },
			{ type: "TurnEnd", payload: {} },
		];
		runResult = { status: "finished", steps: 2 };

		const sdk = new KimiSDK({ workDir: "/tmp/proj" });
		const result = await sdk.run({ prompt: "do it", model: "kimi-latest" });

		expect(result.kind).toBe("kimi");
		expect(result.text).toBe("hello kimi");
		expect(result.raw).toBe(runResult);

		expect(createSessionCalls.length).toBe(1);
		const opts = createSessionCalls[0] as {
			workDir?: string;
			model?: string;
			yoloMode?: boolean;
		};
		expect(opts.workDir).toBe("/tmp/proj");
		expect(opts.model).toBe("kimi-latest");
		expect(opts.yoloMode).toBe(true);
		expect(promptCalls).toEqual(["do it"]);
		expect(closeCalls.length).toBe(1);
	});

	test("run uses defaultModel when opts.model is missing", async () => {
		streamEvents = [];
		const sdk = new KimiSDK({ defaultModel: "kimi-pro" });
		await sdk.run({ prompt: "p" });
		const opts = createSessionCalls[0] as { model?: string };
		expect(opts.model).toBe("kimi-pro");
	});

	test("run omits model when neither provided", async () => {
		streamEvents = [];
		const sdk = new KimiSDK();
		await sdk.run({ prompt: "p" });
		const opts = createSessionCalls[0] as { model?: string };
		expect(opts.model).toBeUndefined();
	});

	test("run defaults workDir to process.cwd() when not configured", async () => {
		streamEvents = [];
		const sdk = new KimiSDK();
		await sdk.run({ prompt: "p" });
		const opts = createSessionCalls[0] as { workDir?: string };
		expect(opts.workDir).toBe(process.cwd());
	});

	test("systemPrompt is prepended to the prompt input", async () => {
		streamEvents = [];
		const sdk = new KimiSDK();
		await sdk.run({ prompt: "real prompt", systemPrompt: "system" });
		expect(promptCalls[0]).toBe("system\n\nreal prompt");
	});

	test("yoloMode can be overridden via config", async () => {
		streamEvents = [];
		const sdk = new KimiSDK({ yoloMode: false });
		await sdk.run({ prompt: "p" });
		const opts = createSessionCalls[0] as { yoloMode?: boolean };
		expect(opts.yoloMode).toBe(false);
	});

	test("thinking, executable, env are forwarded when set", async () => {
		streamEvents = [];
		const sdk = new KimiSDK({
			thinking: true,
			executable: "/usr/bin/kimi",
			env: { KIMI_TOKEN: "abc" },
		});
		await sdk.run({ prompt: "p" });
		const opts = createSessionCalls[0] as {
			thinking?: boolean;
			executable?: string;
			env?: Record<string, string>;
		};
		expect(opts.thinking).toBe(true);
		expect(opts.executable).toBe("/usr/bin/kimi");
		expect(opts.env).toEqual({ KIMI_TOKEN: "abc" });
	});

	test("run returns empty text when no ContentPart text events arrive", async () => {
		streamEvents = [
			{ type: "TurnBegin", payload: {} },
			{ type: "ToolCall", payload: { id: "1", function: { name: "f" } } },
			{ type: "TurnEnd", payload: {} },
		];
		const sdk = new KimiSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("session is closed even if iteration throws", async () => {
		streamEvents = [
			{ type: "ContentPart", payload: { type: "text", text: "boom" } },
		];
		const sdk = new KimiSDK();
		// Hijack the result promise to reject after iteration
		const origResult = runResult;
		try {
			await sdk.run({ prompt: "p" });
		} catch {
			// ignore
		}
		expect(closeCalls.length).toBe(1);
		runResult = origResult;
	});

	test("stream yields delta chunks for ContentPart text events", async () => {
		streamEvents = [
			{ type: "TurnBegin", payload: {} },
			{ type: "ContentPart", payload: { type: "text", text: "Hel" } },
			{ type: "ContentPart", payload: { type: "text", text: "lo" } },
			{ type: "ContentPart", payload: { type: "think", think: "x" } },
			{ type: "TurnEnd", payload: {} },
		];

		const sdk = new KimiSDK();
		const deltas: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			expect(chunk.kind).toBe("kimi");
			deltas.push(chunk.delta);
		}
		expect(deltas).toEqual(["", "Hel", "lo", "", ""]);
		expect(closeCalls.length).toBe(1);
	});
});
