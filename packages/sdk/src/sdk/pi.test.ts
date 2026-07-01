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
const authStorageCreateCalls: Array<string | undefined> = [];
const modelRegistryCreateCalls: Array<{
	authStorage: unknown;
	modelsJsonPath: string | undefined;
}> = [];

let sessionMessages: Array<{
	role: string;
	content: Array<{ type: string; text: string }>;
}> = [];
let emittedEvents: Array<Record<string, unknown>> = [];
let promptShouldThrow: Error | null = null;
let modelFindShouldReturnUndefined = false;
let modelRegistryErrorMessage: string | undefined;
let disposeImpl: () => unknown = () => Promise.resolve();

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
				dispose: () => {
					disposeCalls.push({});
					return disposeImpl();
				},
			},
		};
	},
	AuthStorage: {
		create: (authPath?: string) => {
			authStorageCreateCalls.push(authPath);
			return {
				setRuntimeApiKey: (provider: string, apiKey: string) => {
					setApiKeyCalls.push({ provider, apiKey });
				},
			};
		},
	},
	ModelRegistry: {
		create: (authStorage: unknown, modelsJsonPath?: string) => {
			modelRegistryCreateCalls.push({ authStorage, modelsJsonPath });
			return {
				find: (provider: string, modelId: string) => {
					modelFindCalls.push({ provider, modelId });
					if (modelFindShouldReturnUndefined) return undefined;
					return { provider, modelId };
				},
				registerProvider: (name: string, opts: Record<string, unknown>) => {
					registerProviderCalls.push({ provider: name, opts });
				},
				getError: () => modelRegistryErrorMessage,
			};
		},
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

const { PiSDK, buildAdditionalSkillPaths } = await import("./pi.ts");
const { LimitError } = await import("./errors.ts");

describe("PiSDK", () => {
	beforeEach(() => {
		createSessionCalls.length = 0;
		promptCalls.length = 0;
		disposeCalls.length = 0;
		modelFindCalls.length = 0;
		registerProviderCalls.length = 0;
		setApiKeyCalls.length = 0;
		authStorageCreateCalls.length = 0;
		modelRegistryCreateCalls.length = 0;
		listeners.length = 0;
		sessionMessages = [];
		emittedEvents = [];
		promptShouldThrow = null;
		modelFindShouldReturnUndefined = false;
		modelRegistryErrorMessage = undefined;
		disposeImpl = () => Promise.resolve();
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

	test("model not found error includes the models.json load error alongside it", async () => {
		modelFindShouldReturnUndefined = true;
		modelRegistryErrorMessage = "Invalid models.json schema: ...";
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		await expect(sdk.run({ prompt: "p" })).rejects.toThrow(
			/model not found.*models\.json load error: Invalid models\.json schema/,
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

	test("auth resolves via auth.json / models.json under agentDir even without apiKey (same as pi's own default)", async () => {
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

		expect(authStorageCreateCalls).toEqual(["/tmp/mock-agent-dir/auth.json"]);
		expect(modelRegistryCreateCalls.length).toBe(1);
		expect(modelRegistryCreateCalls[0]?.modelsJsonPath).toBe(
			"/tmp/mock-agent-dir/models.json",
		);
		// No apiKey was passed, so no runtime override is set.
		expect(setApiKeyCalls.length).toBe(0);
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

	test("run: preserves prompt's original error even when dispose() returns a non-Promise (#134)", async () => {
		const err = new Error("connection refused");
		promptShouldThrow = err;
		disposeImpl = () => undefined;
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });

		await expect(sdk.run({ prompt: "p" })).rejects.toBe(err);
		expect(disposeCalls.length).toBe(1);
	});

	test("run: preserves prompt's original error even when dispose() throws synchronously (#134)", async () => {
		const err = new Error("connection refused");
		promptShouldThrow = err;
		disposeImpl = () => {
			throw new Error("dispose failed");
		};
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });

		await expect(sdk.run({ prompt: "p" })).rejects.toBe(err);
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

	test("stream: preserves prompt's original error even when dispose() returns a non-Promise (#134)", async () => {
		const err = new Error("connection refused");
		promptShouldThrow = err;
		disposeImpl = () => undefined;
		const sdk = new PiSDK({ defaultModel: "anthropic/claude-sonnet-4-5" });
		const chunks: Array<{ kind: string; delta: string }> = [];

		await expect(
			(async () => {
				for await (const chunk of sdk.stream({ prompt: "p" })) {
					chunks.push({ kind: chunk.kind, delta: chunk.delta });
				}
			})(),
		).rejects.toBe(err);
		expect(disposeCalls.length).toBe(1);
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

	test("includeClaudeSkills defaults to true; passes ~/.agents/skills + ~/.claude/skills + cwd/.claude/skills as additionalSkillPaths", async () => {
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
		expect(paths).toHaveLength(3);
		// ~/.agents/skills always comes first (same order as Rust seher).
		expect(paths[0]).toMatch(/\.agents\/skills$/);
		expect(paths[1]).toMatch(/\.claude\/skills$/);
		expect(paths[1]).not.toBe("/proj/.claude/skills");
		expect(paths[2]).toBe("/proj/.claude/skills");
		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.resourceLoader).toBeDefined();
		expect(sessionOpts?.settingsManager).toBeDefined();
	});

	test("includeClaudeSkills=false still injects ~/.agents/skills but skips Claude skill paths", async () => {
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
		expect(resourceLoaderCtorCalls.length).toBe(1);
		expect(resourceLoaderReloadCalls.length).toBe(1);
		const opts = resourceLoaderCtorCalls[0];
		const paths = opts?.additionalSkillPaths as string[];
		expect(paths).toHaveLength(1);
		expect(paths[0]).toMatch(/\.agents\/skills$/);
		// `.claude/skills` is not included.
		for (const p of paths) {
			expect(p).not.toMatch(/\.claude\/skills$/);
		}
		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.resourceLoader).toBeDefined();
		expect(sessionOpts?.settingsManager).toBeDefined();
	});
});

describe("buildAdditionalSkillPaths", () => {
	test("includes ~/.agents/skills, ~/.claude/skills, and cwd/.claude/skills by default (in order)", () => {
		const paths = buildAdditionalSkillPaths({
			homeDir: "/home/u",
			cwd: "/proj",
		});
		expect(paths).toEqual([
			"/home/u/.agents/skills",
			"/home/u/.claude/skills",
			"/proj/.claude/skills",
		]);
	});

	test("includeClaudeSkills=true is equivalent to the default", () => {
		const paths = buildAdditionalSkillPaths({
			homeDir: "/home/u",
			cwd: "/proj",
			includeClaudeSkills: true,
		});
		expect(paths).toEqual([
			"/home/u/.agents/skills",
			"/home/u/.claude/skills",
			"/proj/.claude/skills",
		]);
	});

	test("includeClaudeSkills=false drops both Claude skill paths but keeps ~/.agents/skills", () => {
		const paths = buildAdditionalSkillPaths({
			homeDir: "/home/u",
			cwd: "/proj",
			includeClaudeSkills: false,
		});
		expect(paths).toEqual(["/home/u/.agents/skills"]);
	});

	test("~/.agents/skills is always included regardless of includeClaudeSkills value", () => {
		const onTrue = buildAdditionalSkillPaths({
			homeDir: "/h",
			cwd: "/c",
			includeClaudeSkills: true,
		});
		const onFalse = buildAdditionalSkillPaths({
			homeDir: "/h",
			cwd: "/c",
			includeClaudeSkills: false,
		});
		const onUndefined = buildAdditionalSkillPaths({
			homeDir: "/h",
			cwd: "/c",
		});
		expect(onTrue[0]).toBe("/h/.agents/skills");
		expect(onFalse[0]).toBe("/h/.agents/skills");
		expect(onUndefined[0]).toBe("/h/.agents/skills");
	});
});

describe("PiSDK :thinking suffix", () => {
	beforeEach(() => {
		createSessionCalls.length = 0;
		promptCalls.length = 0;
		disposeCalls.length = 0;
		modelFindCalls.length = 0;
		registerProviderCalls.length = 0;
		setApiKeyCalls.length = 0;
		authStorageCreateCalls.length = 0;
		modelRegistryCreateCalls.length = 0;
		listeners.length = 0;
		sessionMessages = [];
		emittedEvents = [];
		promptShouldThrow = null;
		modelFindShouldReturnUndefined = false;
		modelRegistryErrorMessage = undefined;
		disposeImpl = () => Promise.resolve();
	});

	test("strips the `:thinking` suffix before splitting provider/model, and passes thinkingLevel to the session", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK();
		await sdk.run({ prompt: "p", model: "anthropic/claude-opus-4-5:high" });

		expect(modelFindCalls.length).toBe(1);
		expect(modelFindCalls[0]).toEqual({
			provider: "anthropic",
			modelId: "claude-opus-4-5",
		});
		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.thinkingLevel).toBe("high");
	});

	test("alias suffix (`med`) is also normalized to medium before being passed through", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({
			defaultModel: "anthropic/claude-opus-4-5:med",
		});
		await sdk.run({ prompt: "p" });

		expect(modelFindCalls[0]).toEqual({
			provider: "anthropic",
			modelId: "claude-opus-4-5",
		});
		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.thinkingLevel).toBe("medium");
	});

	test("an unrecognized suffix (`:free`) passes through as part of the model name", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK();
		await sdk.run({
			prompt: "p",
			model: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
		});

		expect(modelFindCalls[0]).toEqual({
			provider: "openrouter",
			modelId: "meta-llama/llama-3.1-8b-instruct:free",
		});
		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.thinkingLevel).toBeUndefined();
	});

	test("the suffix's thinkingLevel takes priority over config.thinkingLevel", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({
			defaultModel: "anthropic/claude-opus-4-5:xhigh",
			thinkingLevel: "low",
		});
		await sdk.run({ prompt: "p" });

		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.thinkingLevel).toBe("xhigh");
	});

	test("config.thinkingLevel is used when there's no suffix", async () => {
		emittedEvents = [
			{
				type: "agent_end",
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "ok" }] },
				],
			},
		];
		const sdk = new PiSDK({
			defaultModel: "anthropic/claude-opus-4-5",
			thinkingLevel: "minimal",
		});
		await sdk.run({ prompt: "p" });

		const sessionOpts = createSessionCalls.at(-1);
		expect(sessionOpts?.thinkingLevel).toBe("minimal");
	});
});
