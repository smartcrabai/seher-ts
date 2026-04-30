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
