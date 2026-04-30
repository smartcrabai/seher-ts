import { beforeEach, describe, expect, mock, test } from "bun:test";

const createOpts: Array<Record<string, unknown>> = [];
const sendCalls: unknown[] = [];
const closeCalls: { count: number } = { count: 0 };

let waitResult: { result?: string; status?: string } = {
	status: "finished",
	result: "cursor reply",
};
let waitShouldThrow = false;
let streamEvents: unknown[] = [
	{
		type: "assistant",
		message: { content: [{ type: "text", text: "cursor stream" }] },
	},
];

mock.module("@cursor/sdk", () => {
	class FakeAgent {
		static async create(options: Record<string, unknown>) {
			createOpts.push(options);
			return {
				agentId: "agent_x",
				model: undefined,
				send: async (message: unknown) => {
					sendCalls.push(message);
					return {
						id: "run_x",
						agentId: "agent_x",
						status: "running",
						supports: () => true,
						unsupportedReason: () => undefined,
						stream: async function* () {
							for (const e of streamEvents) yield e;
						},
						wait: async () => {
							if (waitShouldThrow) throw new Error("wait failed");
							return waitResult;
						},
						cancel: async () => {},
						conversation: async () => [],
						onDidChangeStatus: () => () => {},
					};
				},
				close: () => {
					closeCalls.count += 1;
				},
				reload: async () => {},
				listArtifacts: async () => [],
				downloadArtifact: async () => Buffer.from(""),
				[Symbol.asyncDispose]: async () => {},
			};
		}
	}
	return { Agent: FakeAgent };
});

const { CursorSDK } = await import("./cursor.ts");

describe("CursorSDK", () => {
	beforeEach(() => {
		createOpts.length = 0;
		sendCalls.length = 0;
		closeCalls.count = 0;
		waitResult = { status: "finished", result: "cursor reply" };
		waitShouldThrow = false;
		streamEvents = [
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "cursor stream" }] },
			},
		];
	});

	test("run sends prompt as a local agent and returns final result text", async () => {
		const sdk = new CursorSDK({ apiKey: "k", cwd: "/tmp/p" });
		const result = await sdk.run({ prompt: "hi", model: "composer-2" });

		expect(result.kind).toBe("cursor");
		expect(result.text).toBe("cursor reply");
		expect(createOpts.length).toBe(1);
		const opts = createOpts[0] as {
			model?: { id: string };
			apiKey?: string;
			local?: { cwd?: string };
		};
		expect(opts.model).toEqual({ id: "composer-2" });
		expect(opts.apiKey).toBe("k");
		expect(opts.local?.cwd).toBe("/tmp/p");
		expect(sendCalls).toEqual(["hi"]);
		expect(closeCalls.count).toBe(1);
	});

	test("run uses defaultModel when opts.model is missing", async () => {
		const sdk = new CursorSDK({ defaultModel: "composer-3" });
		await sdk.run({ prompt: "p" });
		const opts = createOpts[0] as { model?: { id: string } };
		expect(opts.model).toEqual({ id: "composer-3" });
	});

	test("run falls back to composer-2 when no model is configured", async () => {
		const sdk = new CursorSDK();
		await sdk.run({ prompt: "p" });
		const opts = createOpts[0] as { model?: { id: string } };
		expect(opts.model).toEqual({ id: "composer-2" });
	});

	test("systemPrompt is prepended to the message", async () => {
		const sdk = new CursorSDK();
		await sdk.run({ prompt: "real", systemPrompt: "system" });
		expect(sendCalls).toEqual(["system\n\nreal"]);
	});

	test("cloud=true builds a cloud agent with repos", async () => {
		const sdk = new CursorSDK({
			cloud: true,
			repos: [{ url: "https://github.com/x/y", startingRef: "main" }],
		});
		await sdk.run({ prompt: "p" });
		const opts = createOpts[0] as {
			cloud?: { repos?: Array<{ url: string }> };
			local?: unknown;
		};
		expect(opts.local).toBeUndefined();
		expect(opts.cloud?.repos?.[0]?.url).toBe("https://github.com/x/y");
	});

	test("run returns empty string when wait result has no `result` field", async () => {
		waitResult = { status: "finished" };
		const sdk = new CursorSDK();
		const result = await sdk.run({ prompt: "p" });
		expect(result.text).toBe("");
	});

	test("stream yields delta text from assistant events", async () => {
		streamEvents = [
			{
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "Hel" },
						{ type: "tool_use", id: "x", name: "t", input: {} },
						{ type: "text", text: "lo" },
					],
				},
			},
			{ type: "thinking", text: "ignore me" },
		];
		const sdk = new CursorSDK();
		const deltas: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "p" })) {
			expect(chunk.kind).toBe("cursor");
			deltas.push(chunk.delta);
		}
		expect(deltas).toEqual(["Hello", ""]);
		expect(closeCalls.count).toBe(1);
	});

	test("agent.close is called even when wait() throws", async () => {
		waitShouldThrow = true;
		const sdk = new CursorSDK();
		await expect(sdk.run({ prompt: "p" })).rejects.toThrow("wait failed");
		expect(closeCalls.count).toBe(1);
	});
});
