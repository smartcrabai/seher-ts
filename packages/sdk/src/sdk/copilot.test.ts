import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mockDefineTool } from "./__test__/mockProviderTools.ts";

const constructorCalls: Array<Record<string, unknown>> = [];
const startCalls: number[] = [];
const createSessionCalls: Array<Record<string, unknown>> = [];
const sendAndWaitCalls: Array<{
	opts: Record<string, unknown>;
	timeout: number | undefined;
}> = [];
const disconnectCalls: number[] = [];

let sendAndWaitResult:
	| { data?: { content?: string; messageId?: string } }
	| undefined = {
	data: { content: "copilot reply", messageId: "m-1" },
};

let streamDeltas: string[] = [];
let emitErrorEvent: {
	errorType?: string;
	message?: string;
	statusCode?: number;
} | null = null;

const APPROVE_ALL_SENTINEL = Symbol("approveAll");

mock.module("@github/copilot-sdk", () => {
	class MockCopilotClient {
		constructor(opts: Record<string, unknown> = {}) {
			constructorCalls.push(opts);
		}
		async start() {
			startCalls.push(1);
		}
		async createSession(config: Record<string, unknown>) {
			createSessionCalls.push(config);
			const handlers = new Map<string, (event: unknown) => void>();
			return {
				on: (eventType: string, handler: (event: unknown) => void) => {
					handlers.set(eventType, handler);
					return () => {
						handlers.delete(eventType);
					};
				},
				send: async () => {},
				sendAndWait: async (
					opts: Record<string, unknown>,
					timeout?: number,
				) => {
					sendAndWaitCalls.push({ opts, timeout });
					if (emitErrorEvent !== null) {
						const errHandler = handlers.get("session.error");
						if (errHandler !== undefined) {
							errHandler({
								type: "session.error",
								data: emitErrorEvent,
							});
						}
					}
					if (config.streaming === true) {
						const deltaHandler = handlers.get("assistant.message_delta") as
							| ((event: { data?: { deltaContent?: string } }) => void)
							| undefined;
						if (deltaHandler !== undefined) {
							for (const delta of streamDeltas) {
								deltaHandler({ data: { deltaContent: delta } });
							}
						}
						const messageHandler = handlers.get("assistant.message") as
							| ((event: { data?: { content?: string } }) => void)
							| undefined;
						if (messageHandler !== undefined) {
							messageHandler({
								data: { content: streamDeltas.join("") },
							});
						}
					}
					return sendAndWaitResult;
				},
				disconnect: async () => {
					disconnectCalls.push(1);
				},
			};
		}
	}
	return {
		CopilotClient: MockCopilotClient,
		approveAll: APPROVE_ALL_SENTINEL,
		defineTool: mockDefineTool,
	};
});

const { CopilotSDK } = await import("./copilot.ts");
const { LimitError } = await import("./errors.ts");

describe("CopilotSDK", () => {
	beforeEach(() => {
		constructorCalls.length = 0;
		startCalls.length = 0;
		createSessionCalls.length = 0;
		sendAndWaitCalls.length = 0;
		disconnectCalls.length = 0;
		emitErrorEvent = null;
	});

	test("run forwards prompt and model, returns content text", async () => {
		sendAndWaitResult = {
			data: { content: "hello from copilot", messageId: "m-2" },
		};

		const sdk = new CopilotSDK({ gitHubToken: "tok" });
		const result = await sdk.run({ prompt: "do it", model: "gpt-5-codex" });

		expect(result.kind).toBe("copilot");
		expect(result.text).toBe("hello from copilot");
		expect(result.raw).toBe(sendAndWaitResult);

		expect(createSessionCalls.length).toBe(1);
		const sessionConfig = createSessionCalls[0] as {
			model?: string;
			onPermissionRequest?: unknown;
		};
		expect(sessionConfig.model).toBe("gpt-5-codex");
		expect(sessionConfig.onPermissionRequest).toBe(APPROVE_ALL_SENTINEL);
		expect(sendAndWaitCalls).toEqual([
			{ opts: { prompt: "do it" }, timeout: undefined },
		]);
		expect(disconnectCalls.length).toBe(1);
	});

	test("run uses defaultModel when opts.model is missing", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({ defaultModel: "claude-sonnet-4.5" });
		await sdk.run({ prompt: "p" });
		const sessionConfig = createSessionCalls[0] as { model?: string };
		expect(sessionConfig.model).toBe("claude-sonnet-4.5");
	});

	test("run falls back to gpt-5 by default", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK();
		await sdk.run({ prompt: "p" });
		const sessionConfig = createSessionCalls[0] as { model?: string };
		expect(sessionConfig.model).toBe("gpt-5");
	});

	test("effortLevel is forwarded as sessionConfig.reasoningEffort", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({ effortLevel: "high" });
		await sdk.run({ prompt: "p" });
		const sessionConfig = createSessionCalls[0] as {
			reasoningEffort?: string;
		};
		expect(sessionConfig.reasoningEffort).toBe("high");
	});

	test("effortLevel max rounds down to xhigh (Copilot has no max tier)", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({ effortLevel: "max" });
		await sdk.run({ prompt: "p" });
		const sessionConfig = createSessionCalls[0] as {
			reasoningEffort?: string;
		};
		expect(sessionConfig.reasoningEffort).toBe("xhigh");
	});

	test("no reasoningEffort is set when effortLevel is unset", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK();
		await sdk.run({ prompt: "p" });
		const sessionConfig = createSessionCalls[0] as {
			reasoningEffort?: string;
		};
		expect(sessionConfig.reasoningEffort).toBeUndefined();
	});

	test("systemPrompt is forwarded as systemMessage.append", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK();
		await sdk.run({ prompt: "real prompt", systemPrompt: "system" });
		const sessionConfig = createSessionCalls[0] as {
			systemMessage?: { append?: string };
		};
		expect(sessionConfig.systemMessage).toEqual({ append: "system" });
	});

	test("run returns empty text when sendAndWait yields no data", async () => {
		sendAndWaitResult = undefined;
		const sdk = new CopilotSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("config.timeoutMs is forwarded to sendAndWait", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({ timeoutMs: 300_000 });
		await sdk.run({ prompt: "p" });
		expect(sendAndWaitCalls).toEqual([
			{ opts: { prompt: "p" }, timeout: 300_000 },
		]);
	});

	test("runOpts.timeoutMs overrides config.timeoutMs", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({ timeoutMs: 300_000 });
		await sdk.run({ prompt: "p", timeoutMs: 600_000 });
		expect(sendAndWaitCalls).toEqual([
			{ opts: { prompt: "p" }, timeout: 600_000 },
		]);
	});

	test("stream forwards timeoutMs to sendAndWait", async () => {
		streamDeltas = ["a"];
		sendAndWaitResult = { data: { content: "a" } };
		const sdk = new CopilotSDK({ timeoutMs: 120_000 });
		for await (const _chunk of sdk.stream({ prompt: "p" })) {
			// drain
		}
		expect(sendAndWaitCalls).toEqual([
			{ opts: { prompt: "p" }, timeout: 120_000 },
		]);
	});

	test("client is lazily constructed and started", async () => {
		new CopilotSDK({ gitHubToken: "tok" });
		expect(constructorCalls.length).toBe(0);
		expect(startCalls.length).toBe(0);
	});

	test("client is reused across run() calls", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({ gitHubToken: "tok" });
		await sdk.run({ prompt: "1" });
		await sdk.run({ prompt: "2" });
		expect(constructorCalls.length).toBe(1);
		expect(startCalls.length).toBe(1);
		expect(createSessionCalls.length).toBe(2);
		expect(disconnectCalls.length).toBe(2);
	});

	test("constructor opts are forwarded on first use", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({
			gitHubToken: "ghp_xxx",
			cliPath: "/bin/copilot",
			cliUrl: "localhost:8080",
		});
		await sdk.run({ prompt: "p" });
		expect(constructorCalls.length).toBe(1);
		expect(constructorCalls[0]).toEqual({
			gitHubToken: "ghp_xxx",
			cliPath: "/bin/copilot",
			cliUrl: "localhost:8080",
		});
	});

	test("config.env is forwarded to the CopilotClient constructor, merged with process.env", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const previous = process.env.SEHER_COPILOT_ENV_TEST;
		process.env.SEHER_COPILOT_ENV_TEST = "from-process";
		try {
			const sdk = new CopilotSDK({ gitHubToken: "tok", env: { FOO: "bar" } });
			await sdk.run({ prompt: "p" });
			const opts = constructorCalls[0] as { env?: Record<string, string> };
			expect(opts.env?.FOO).toBe("bar");
			expect(opts.env?.SEHER_COPILOT_ENV_TEST).toBe("from-process");
		} finally {
			if (previous === undefined) {
				delete process.env.SEHER_COPILOT_ENV_TEST;
			} else {
				process.env.SEHER_COPILOT_ENV_TEST = previous;
			}
		}
	});

	test("no env key is set on CopilotClient constructor opts when config.env is empty/unset", async () => {
		sendAndWaitResult = { data: { content: "x" } };
		const sdk = new CopilotSDK({ gitHubToken: "tok" });
		await sdk.run({ prompt: "p" });
		const opts = constructorCalls[0] as { env?: Record<string, string> };
		expect(opts.env).toBeUndefined();

		const sdkWithEmptyEnv = new CopilotSDK({
			gitHubToken: "tok",
			env: {},
		});
		await sdkWithEmptyEnv.run({ prompt: "p" });
		const opts2 = constructorCalls[1] as { env?: Record<string, string> };
		expect(opts2.env).toBeUndefined();
	});

	test("stream yields delta chunks for assistant.message_delta events", async () => {
		streamDeltas = ["Hel", "lo ", "world"];
		sendAndWaitResult = { data: { content: "Hello world" } };

		const sdk = new CopilotSDK();
		const deltas: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			expect(chunk.kind).toBe("copilot");
			deltas.push(chunk.delta);
		}
		expect(deltas.filter((d) => d.length > 0)).toEqual(["Hel", "lo ", "world"]);
		const sessionConfig = createSessionCalls[0] as { streaming?: boolean };
		expect(sessionConfig.streaming).toBe(true);
		expect(disconnectCalls.length).toBe(1);
	});

	test("stream disconnects the session even if no deltas arrive", async () => {
		streamDeltas = [];
		sendAndWaitResult = { data: { content: "" } };
		const sdk = new CopilotSDK();
		for await (const _ of sdk.stream({ prompt: "p" })) {
			// drain
		}
		expect(disconnectCalls.length).toBe(1);
	});

	test("tools are forwarded to sessionConfig.tools via defineTool", async () => {
		const { z } = await import("zod");
		const echo = {
			name: "echo",
			description: "Echo input",
			parameters: z.object({ msg: z.string() }),
			handler: async ({ msg }: { msg: string }) => `echoed: ${msg}`,
		};
		const sdk = new CopilotSDK({ tools: [echo] });
		await sdk.run({ prompt: "p" });

		const sessionConfig = createSessionCalls[0] as {
			tools?: Array<{ __seherCopilotTool: boolean; name: string }>;
		};
		expect(sessionConfig.tools?.length).toBe(1);
		expect(sessionConfig.tools?.[0]?.__seherCopilotTool).toBe(true);
		expect(sessionConfig.tools?.[0]?.name).toBe("echo");
	});

	test("empty tools array does not set sessionConfig.tools", async () => {
		const sdk = new CopilotSDK({ tools: [] });
		await sdk.run({ prompt: "p" });
		const sessionConfig = createSessionCalls[0] as { tools?: unknown };
		expect(sessionConfig.tools).toBeUndefined();
	});

	test("run() converts session.error with errorType=rate_limit into LimitError", async () => {
		emitErrorEvent = { errorType: "rate_limit", message: "Too many" };
		const sdk = new CopilotSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toBeInstanceOf(LimitError);
		expect(disconnectCalls.length).toBe(1);
	});

	test("run() converts session.error with statusCode=429 into LimitError", async () => {
		emitErrorEvent = { errorType: "query", statusCode: 429, message: "429" };
		const sdk = new CopilotSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toBeInstanceOf(LimitError);
	});

	test("run() ignores non-limit session.error events", async () => {
		emitErrorEvent = { errorType: "authentication", message: "unauth" };
		sendAndWaitResult = { data: { content: "still ok" } };
		const sdk = new CopilotSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("still ok");
	});
});
