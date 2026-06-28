import { beforeEach, describe, expect, mock, test } from "bun:test";

const createSessionCalls: Array<Record<string, unknown>> = [];
const promptCalls: string[] = [];
const disposeCalls: unknown[] = [];
const modelFindCalls: Array<{ provider: string; modelId: string }> = [];
const registerProviderCalls: Array<{
	provider: string;
	opts: Record<string, unknown>;
}> = [];
const setApiKeyCalls: Array<{ provider: string; apiKey: string }> = [];
const resourceLoaderCtorCalls: Array<Record<string, unknown>> = [];
const resourceLoaderReloadCalls: number[] = [];

let sessionMessages: Array<{
	role: string;
	content: Array<{ type: string; text: string }>;
}> = [];
let emittedEvents: Array<Record<string, unknown>> = [];
let promptShouldThrow: Error | null = null;

const listeners: Array<(event: unknown) => void> = [];

mock.module("@earendil-works/pi-coding-agent", () => ({
	createAgentSession: async (options?: Record<string, unknown>) => {
		createSessionCalls.push(options ?? {});
		return {
			session: {
				prompt: async (text: string) => {
					promptCalls.push(text);
					if (promptShouldThrow !== null) throw promptShouldThrow;
					for (const listener of listeners) {
						for (const event of emittedEvents) {
							listener(event);
						}
					}
				},
				subscribe: (listener: (event: unknown) => void) => {
					listeners.push(listener);
					return () => {
						const idx = listeners.indexOf(listener);
						if (idx >= 0) listeners.splice(idx, 1);
					};
				},
				state: {
					get messages() {
						return sessionMessages;
					},
				},
				dispose: async () => {
					disposeCalls.push({});
				},
			},
		};
	},
	AuthStorage: {
		inMemory: () => ({
			setRuntimeApiKey: (provider: string, apiKey: string) => {
				setApiKeyCalls.push({ provider, apiKey });
			},
		}),
	},
	ModelRegistry: {
		inMemory: (_authStorage?: unknown) => ({
			find: (provider: string, modelId: string) => {
				modelFindCalls.push({ provider, modelId });
				return { provider, modelId };
			},
			registerProvider: (name: string, opts: Record<string, unknown>) => {
				registerProviderCalls.push({ provider: name, opts });
			},
		}),
	},
	DefaultResourceLoader: class {
		constructor(opts: Record<string, unknown>) {
			resourceLoaderCtorCalls.push(opts);
		}
		async reload() {
			resourceLoaderReloadCalls.push(Date.now());
		}
	},
	getAgentDir: () => "/tmp/mock-agent-dir",
	SettingsManager: {
		create: (_cwd: string, _agentDir: string) => ({}),
	},
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

const { PiSDK } = await import("./pi.ts");
const { LimitError } = await import("./errors.ts");

describe("PiSDK", () => {
	beforeEach(() => {
		createSessionCalls.length = 0;
		promptCalls.length = 0;
		disposeCalls.length = 0;
		modelFindCalls.length = 0;
		registerProviderCalls.length = 0;
		setApiKeyCalls.length = 0;
		listeners.length = 0;
		sessionMessages = [];
		emittedEvents = [];
		promptShouldThrow = null;
	});

	test("run invokes createAgentSession and returns text from agent_end messages", async () => {
		emittedEvents = [
			{
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "pi reply" }],
				},
			},
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: [{ type: "text", text: "hello" }] },
					{
						role: "assistant",
						content: [{ type: "text", text: "pi reply" }],
					},
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		const result = await sdk.run({ prompt: "hello" });

		expect(result.kind).toBe("pi");
		expect(result.text).toBe("pi reply");
		expect(createSessionCalls.length).toBe(1);
		expect(promptCalls).toHaveLength(1);
		expect(promptCalls[0]).toBe("hello");
	});

	test("run prepends system prompt when systemPrompt is provided", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await sdk.run({ prompt: "do it", systemPrompt: "you are helpful" });

		expect(promptCalls[0]).toBe("you are helpful\n\ndo it");
	});

	test("run parses model as providerID/modelID via registry.find", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK();
		await sdk.run({ prompt: "p", model: "openai/gpt-5" });

		expect(modelFindCalls.length).toBe(1);
		expect(modelFindCalls[0]).toEqual({ provider: "openai", modelId: "gpt-5" });
	});

	test("run falls back to defaultProviderID when model has no slash", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({ defaultProviderID: "openai" });
		await sdk.run({ prompt: "p", model: "gpt-5" });

		expect(modelFindCalls.length).toBe(1);
		expect(modelFindCalls[0]).toEqual({ provider: "openai", modelId: "gpt-5" });
	});

	test("run uses defaultModel when no model is passed", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "google/gemini-pro" });
		await sdk.run({ prompt: "p" });

		expect(modelFindCalls.length).toBe(1);
		expect(modelFindCalls[0]).toEqual({
			provider: "google",
			modelId: "gemini-pro",
		});
	});

	test("run throws when neither model nor defaultModel is specified", async () => {
		const sdk = new PiSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toThrow(
			/no model configured/,
		);
	});

	test("stream yields text_delta chunks from message_update events", async () => {
		emittedEvents = [
			{
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ignored" }],
				},
				assistantMessageEvent: { type: "text_delta", delta: "hello " },
			},
			{
				type: "message_update",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ignored" }],
				},
				assistantMessageEvent: { type: "text_delta", delta: "world" },
			},
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "hello world" }],
					},
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		const chunks: Array<{ kind: string; delta: string }> = [];
		for await (const chunk of sdk.stream({ prompt: "p" })) {
			chunks.push({ kind: chunk.kind, delta: chunk.delta });
		}
		expect(chunks).toEqual([
			{ kind: "pi", delta: "hello " },
			{ kind: "pi", delta: "world" },
		]);
	});

	test("run converts rate-limit error to LimitError", async () => {
		promptShouldThrow = new Error("usage limit exceeded: rate limit hit");
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await expect(sdk.run({ prompt: "p" })).rejects.toBeInstanceOf(LimitError);
	});

	test("run passes through non-limit errors unchanged", async () => {
		const err = new Error("connection refused");
		promptShouldThrow = err;
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await expect(sdk.run({ prompt: "p" })).rejects.toBe(err);
	});

	test("close disposes the session", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await sdk.run({ prompt: "p" });
		expect(disposeCalls.length).toBe(0);
		await sdk.close();
		expect(disposeCalls.length).toBe(1);
	});

	test("close disposes session even when run never called", async () => {
		const sdk = new PiSDK();
		await sdk.close();
		expect(disposeCalls.length).toBe(0);
	});

	test("apiKey is passed to AuthStorage.setRuntimeApiKey", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({
			apiKey: "sk-test",
			defaultModel: "anthropic/claude-sonnet-4-5",
		});
		await sdk.run({ prompt: "p" });

		expect(setApiKeyCalls.length).toBe(1);
		expect(setApiKeyCalls[0]).toEqual({
			provider: "anthropic",
			apiKey: "sk-test",
		});
	});

	test("baseURL is registered via ModelRegistry.registerProvider", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({
			baseURL: "https://api.example.com",
			defaultModel: "openai/gpt-5",
		});
		await sdk.run({ prompt: "p" });

		expect(registerProviderCalls.length).toBe(1);
		expect(registerProviderCalls[0]?.provider).toBe("openai");
		expect(registerProviderCalls[0]?.opts).toMatchObject({
			baseUrl: "https://api.example.com",
		});
	});

	test("run yields empty text when agent_end has no assistant message", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "user", content: [{ type: "text", text: "hello" }] },
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		const result = await sdk.run({ prompt: "hello" });

		expect(result.text).toBe("");
	});

	test("dispose is called even when prompt throws", async () => {
		promptShouldThrow = new Error("connection refused");
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await expect(sdk.run({ prompt: "p" })).rejects.toThrow(
			"connection refused",
		);
		expect(disposeCalls.length).toBe(1);
	});

	test("[Symbol.asyncDispose] calls close", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await sdk.run({ prompt: "p" });
		expect(disposeCalls.length).toBe(0);
		await sdk[Symbol.asyncDispose]();
		expect(disposeCalls.length).toBe(1);
	});

	test("stream handles error during prompt and rethrows as LimitError when limit pattern matches", async () => {
		promptShouldThrow = new Error("429 too many requests");
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		const chunks: Array<{ kind: string; delta: string }> = [];
		await expect(
			(async () => {
				for await (const chunk of sdk.stream({ prompt: "p" })) {
					chunks.push({ kind: chunk.kind, delta: chunk.delta });
				}
			})(),
		).rejects.toBeInstanceOf(LimitError);
	});

	test("creates session lazily, reuses across multiple runs", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await sdk.run({ prompt: "p1" });
		await sdk.run({ prompt: "p2" });
		expect(createSessionCalls.length).toBe(1);
	});

	test("includeClaudeSkills defaults to true; passes ~/.claude/skills + cwd/.claude/skills as additionalSkillPaths", async () => {
		resourceLoaderCtorCalls.length = 0;
		resourceLoaderReloadCalls.length = 0;
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({
			defaultModel: "anthropic/claude-sonnet-4-5",
			cwd: "/proj",
		});
		await sdk.run({ prompt: "p" });
		expect(resourceLoaderCtorCalls.length).toBe(1);
		expect(resourceLoaderReloadCalls.length).toBe(1);
		const opts = resourceLoaderCtorCalls[0];
		expect(opts?.cwd).toBe("/proj");
		expect(opts?.agentDir).toBe("/tmp/mock-agent-dir");
		const paths = opts?.additionalSkillPaths as string[];
		expect(paths).toHaveLength(2);
		expect(paths[0]).toMatch(/\.claude\/skills$/);
		expect(paths[1]).toBe("/proj/.claude/skills");
		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.resourceLoader).toBeDefined();
		expect(sessionOpts?.settingsManager).toBeDefined();
	});

	test("includeClaudeSkills=false skips the resource loader injection entirely", async () => {
		resourceLoaderCtorCalls.length = 0;
		resourceLoaderReloadCalls.length = 0;
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({
			defaultModel: "anthropic/claude-sonnet-4-5",
			cwd: "/proj",
			includeClaudeSkills: false,
		});
		await sdk.run({ prompt: "p" });
		expect(resourceLoaderCtorCalls.length).toBe(0);
		expect(resourceLoaderReloadCalls.length).toBe(0);
		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.resourceLoader).toBeUndefined();
		expect(sessionOpts?.settingsManager).toBeUndefined();
	});
});
