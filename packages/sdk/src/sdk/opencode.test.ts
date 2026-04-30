import { beforeEach, describe, expect, mock, test } from "bun:test";

const createCalls: Array<Record<string, unknown> | undefined> = [];
const promptCalls: unknown[] = [];
const deleteCalls: unknown[] = [];
const createOpencodeCalls: Array<Record<string, unknown>> = [];
const createOpencodeClientCalls: Array<Record<string, unknown>> = [];
const serverClosed: { value: boolean } = { value: false };

let promptResponse: unknown = {
	data: {
		info: { id: "msg_1" },
		parts: [
			{ type: "text", text: "hello " },
			{ type: "text", text: "world" },
		],
	},
};

let sessionId = "session_1";

mock.module("@opencode-ai/sdk", () => {
	const fakeClient = {
		session: {
			create: async (opts?: Record<string, unknown>) => {
				createCalls.push(opts);
				return sessionId === ""
					? { data: undefined }
					: { data: { id: sessionId } };
			},
			prompt: async (opts: unknown) => {
				promptCalls.push(opts);
				return promptResponse;
			},
			delete: async (opts: unknown) => {
				deleteCalls.push(opts);
				return { data: true };
			},
		},
	};
	return {
		createOpencodeClient: (cfg: Record<string, unknown> = {}) => {
			createOpencodeClientCalls.push(cfg);
			return fakeClient;
		},
		createOpencode: async (cfg: Record<string, unknown> = {}) => {
			createOpencodeCalls.push(cfg);
			return {
				client: fakeClient,
				server: {
					url: "http://127.0.0.1:4096",
					close: () => {
						serverClosed.value = true;
					},
				},
			};
		},
	};
});

const { OpencodeSDK } = await import("./opencode.ts");

describe("OpencodeSDK", () => {
	beforeEach(() => {
		createCalls.length = 0;
		promptCalls.length = 0;
		deleteCalls.length = 0;
		createOpencodeCalls.length = 0;
		createOpencodeClientCalls.length = 0;
		serverClosed.value = false;
		sessionId = "session_1";
		promptResponse = {
			data: {
				info: { id: "msg_1" },
				parts: [
					{ type: "text", text: "hello " },
					{ type: "text", text: "world" },
				],
			},
		};
	});

	test("run uses createOpencode when no baseURL is provided", async () => {
		const sdk = new OpencodeSDK({ port: 4096, hostname: "127.0.0.1" });
		const result = await sdk.run({ prompt: "hi" });

		expect(result.kind).toBe("opencode");
		expect(result.text).toBe("hello world");
		expect(createOpencodeCalls.length).toBe(1);
		expect(createOpencodeClientCalls.length).toBe(0);
		const startOpts = createOpencodeCalls[0] as {
			port?: number;
			hostname?: string;
		};
		expect(startOpts.port).toBe(4096);
		expect(startOpts.hostname).toBe("127.0.0.1");
	});

	test("run uses createOpencodeClient when baseURL is provided", async () => {
		const sdk = new OpencodeSDK({
			baseURL: "http://example.test:4096",
			headers: { Authorization: "Basic abc" },
		});
		await sdk.run({ prompt: "hi" });
		expect(createOpencodeClientCalls.length).toBe(1);
		expect(createOpencodeCalls.length).toBe(0);
		const cfg = createOpencodeClientCalls[0] as {
			baseUrl?: string;
			headers?: Record<string, string>;
		};
		expect(cfg.baseUrl).toBe("http://example.test:4096");
		expect(cfg.headers?.Authorization).toBe("Basic abc");
	});

	test("run forwards model parsed as providerID/modelID", async () => {
		const sdk = new OpencodeSDK();
		await sdk.run({ prompt: "do", model: "anthropic/claude-3-5-sonnet" });
		const body = (promptCalls[0] as { body: { model: unknown } }).body;
		expect(body.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-3-5-sonnet",
		});
	});

	test("run falls back to defaultProviderID when model has no slash", async () => {
		const sdk = new OpencodeSDK({ defaultProviderID: "openai" });
		await sdk.run({ prompt: "do", model: "gpt-5" });
		const body = (promptCalls[0] as { body: { model: unknown } }).body;
		expect(body.model).toEqual({ providerID: "openai", modelID: "gpt-5" });
	});

	test("systemPrompt is forwarded as body.system", async () => {
		const sdk = new OpencodeSDK();
		await sdk.run({ prompt: "p", systemPrompt: "you are helpful" });
		const body = (
			promptCalls[0] as {
				body: { system?: string; parts: Array<{ type: string; text: string }> };
			}
		).body;
		expect(body.system).toBe("you are helpful");
		expect(body.parts).toEqual([{ type: "text", text: "p" }]);
	});

	test("agent option is forwarded to body.agent", async () => {
		const sdk = new OpencodeSDK({ agent: "build" });
		await sdk.run({ prompt: "p" });
		const body = (promptCalls[0] as { body: { agent?: string } }).body;
		expect(body.agent).toBe("build");
	});

	test("session id from session.create is used in prompt path", async () => {
		sessionId = "session_xyz";
		const sdk = new OpencodeSDK();
		await sdk.run({ prompt: "p" });
		const opts = promptCalls[0] as { path: { id: string } };
		expect(opts.path.id).toBe("session_xyz");
	});

	test("returns empty text when no text parts", async () => {
		promptResponse = {
			data: {
				info: { id: "m" },
				parts: [{ type: "tool", text: "ignored" }],
			},
		};
		const sdk = new OpencodeSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("stream yields a single chunk with the full text", async () => {
		const sdk = new OpencodeSDK();
		const chunks: Array<{ kind: string; delta: string }> = [];
		for await (const chunk of sdk.stream({ prompt: "p" })) {
			chunks.push({ kind: chunk.kind, delta: chunk.delta });
		}
		expect(chunks).toEqual([{ kind: "opencode", delta: "hello world" }]);
	});

	test("close() shuts down a server spawned by createOpencode", async () => {
		const sdk = new OpencodeSDK();
		await sdk.run({ prompt: "p" });
		expect(serverClosed.value).toBe(false);
		await sdk.close();
		expect(serverClosed.value).toBe(true);
	});

	test("client is reused across runs", async () => {
		const sdk = new OpencodeSDK();
		await sdk.run({ prompt: "p1" });
		await sdk.run({ prompt: "p2" });
		expect(createOpencodeCalls.length).toBe(1);
	});

	test("throws when session.create returns no id", async () => {
		sessionId = "";
		const sdk = new OpencodeSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toThrow(/no session id/);
	});

	test("session is deleted after a successful run", async () => {
		sessionId = "session_to_clean";
		const sdk = new OpencodeSDK();
		await sdk.run({ prompt: "p" });
		expect(deleteCalls.length).toBe(1);
		const opts = deleteCalls[0] as { path: { id: string } };
		expect(opts.path.id).toBe("session_to_clean");
	});

	test("session is deleted even when prompt throws", async () => {
		const sdk = new OpencodeSDK();
		promptResponse = Promise.reject(new Error("boom"));
		await expect(sdk.run({ prompt: "p" })).rejects.toThrow("boom");
		expect(deleteCalls.length).toBe(1);
	});
});
