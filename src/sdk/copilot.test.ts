import { beforeEach, describe, expect, mock, test } from "bun:test";

const constructorCalls: Array<Record<string, unknown>> = [];
const startCalls: number[] = [];
const createSessionCalls: Array<Record<string, unknown>> = [];
const sendAndWaitCalls: Array<Record<string, unknown>> = [];
const disconnectCalls: number[] = [];

let sendAndWaitResult:
	| { data?: { content?: string; messageId?: string } }
	| undefined = {
	data: { content: "copilot reply", messageId: "m-1" },
};

let streamDeltas: string[] = [];

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
			const handlers = new Map<
				string,
				(event: { data?: { content?: string; deltaContent?: string } }) => void
			>();
			return {
				on: (
					eventType: string,
					handler: (event: {
						data?: { content?: string; deltaContent?: string };
					}) => void,
				) => {
					handlers.set(eventType, handler);
					return () => {
						handlers.delete(eventType);
					};
				},
				send: async () => {},
				sendAndWait: async (opts: Record<string, unknown>) => {
					sendAndWaitCalls.push(opts);
					if (config.streaming === true) {
						const deltaHandler = handlers.get("assistant.message_delta");
						if (deltaHandler !== undefined) {
							for (const delta of streamDeltas) {
								deltaHandler({ data: { deltaContent: delta } });
							}
						}
						const messageHandler = handlers.get("assistant.message");
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
	};
});

const { CopilotSDK } = await import("./copilot.ts");

describe("CopilotSDK", () => {
	beforeEach(() => {
		constructorCalls.length = 0;
		startCalls.length = 0;
		createSessionCalls.length = 0;
		sendAndWaitCalls.length = 0;
		disconnectCalls.length = 0;
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
		expect(sendAndWaitCalls).toEqual([{ prompt: "do it" }]);
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
});
