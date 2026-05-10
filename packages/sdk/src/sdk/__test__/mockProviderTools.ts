/**
 * Pure mock factories for the underlying provider SDKs' tool-registration
 * helpers. These are shared by `*.test.ts` files that need to mock those
 * symbols at module-load time without importing real network-touching code.
 *
 * Each factory returns a tagged object so tests can assert on the marker
 * (`__seherToolDef`, `__seherSdkMcp`, `__seherCopilotTool`, `__seherKimiTool`).
 */

export function mockClaudeTool(
	name: string,
	description: string,
	inputSchema: unknown,
	handler: (args: unknown) => unknown,
) {
	return { __seherToolDef: true, name, description, inputSchema, handler };
}

export function mockCreateSdkMcpServer(opts: {
	name: string;
	tools?: unknown[];
}) {
	return {
		__seherSdkMcp: true,
		type: "sdk",
		name: opts.name,
		tools: opts.tools ?? [],
	};
}

export function mockDefineTool(
	name: string,
	config: {
		description?: string;
		parameters?: unknown;
		handler: (args: unknown) => unknown;
	},
) {
	return {
		__seherCopilotTool: true,
		name,
		description: config.description,
		parameters: config.parameters,
		handler: config.handler,
	};
}

export function mockCreateExternalTool(definition: {
	name: string;
	description: string;
	parameters: unknown;
	handler: (args: unknown) => unknown;
}) {
	return { __seherKimiTool: true, ...definition };
}

/**
 * Mock Cursor Agent object factory for `mock.module("@cursor/sdk", ...)`.
 * Returns a FakeAgent with `create()` that records calls and returns a
 * fully-stubbed agent instance. The `createOpts` array and `streamEvents`
 * variable must be provided by the test file.
 */
export function mockCursorAgent(
	createOpts: Array<Record<string, unknown>>,
	streamEvents: unknown[],
) {
	return {
		create: async (options: Record<string, unknown>) => {
			createOpts.push(options);
			return {
				agentId: "agent_x",
				model: undefined,
				send: async (message: unknown) => ({
					id: "run_x",
					agentId: "agent_x",
					status: "running",
					supports: () => true,
					unsupportedReason: () => undefined,
					stream: async function* () {
						for (const e of streamEvents) yield e;
					},
					wait: async () => ({ status: "finished", result: "cursor reply" }),
					cancel: async () => {},
					conversation: async () => [],
					onDidChangeStatus: () => () => {},
				}),
				close: () => {},
				reload: async () => {},
				listArtifacts: async () => [],
				downloadArtifact: async () => Buffer.from(""),
				[Symbol.asyncDispose]: async () => {},
			};
		},
	};
}
