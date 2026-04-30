import {
	createSdkMcpServer,
	type Options,
	type PermissionMode,
	query,
	tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";
import { extractTextBlocks } from "./text.ts";
import type { SeherTool } from "./tools.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

export interface ClaudeSDKConfig {
	apiKey?: string;
	baseURL?: string;
	defaultModel?: string;
	/** Permission mode for the Claude agent. `"auto"` uses a model classifier. */
	permissionMode?: PermissionMode;
	cwd?: string;
	/**
	 * Extra environment variables forwarded to the spawned Claude agent process.
	 * `apiKey` / `baseURL` (translated to `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`)
	 * take precedence over keys with the same name set here.
	 */
	env?: Record<string, string>;
	/**
	 * In-process tools registered via SeherSDK. Forwarded to the Claude agent
	 * as an SDK MCP server (`mcpServers.seher_tools`).
	 */
	tools?: SeherTool<z.ZodObject<z.ZodRawShape>>[];
}

function toClaudeTool(t: SeherTool<z.ZodObject<z.ZodRawShape>>) {
	return tool(
		t.name,
		t.description,
		t.parameters.shape,
		async (args: Record<string, unknown>) => {
			const text = await t.handler(args as never);
			return { content: [{ type: "text" as const, text }] };
		},
	);
}

const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
const SEHER_TOOLS_MCP_NAME = "seher_tools";

export class ClaudeSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "claude";
	private readonly config: ClaudeSDKConfig;
	private readonly mcpServers: Options["mcpServers"];

	constructor(config: ClaudeSDKConfig = {}) {
		this.config = config;
		const tools = config.tools;
		this.mcpServers =
			tools !== undefined && tools.length > 0
				? {
						[SEHER_TOOLS_MCP_NAME]: createSdkMcpServer({
							name: SEHER_TOOLS_MCP_NAME,
							tools: tools.map(toClaudeTool),
						}),
					}
				: undefined;
	}

	private buildOptions(opts: SeherRunOptions): Options {
		const permissionMode =
			this.config.permissionMode ?? DEFAULT_PERMISSION_MODE;
		const options: Options = {
			permissionMode,
			settingSources: ["user", "project"],
		};
		if (permissionMode === "bypassPermissions") {
			options.allowDangerouslySkipPermissions = true;
		}
		const model = opts.model ?? this.config.defaultModel;
		if (model !== undefined) options.model = model;
		if (opts.systemPrompt !== undefined) {
			options.systemPrompt = opts.systemPrompt;
		}
		if (this.config.cwd !== undefined) options.cwd = this.config.cwd;

		const env: Record<string, string> = { ...(this.config.env ?? {}) };
		if (this.config.apiKey !== undefined) {
			env.ANTHROPIC_API_KEY = this.config.apiKey;
		}
		if (this.config.baseURL !== undefined) {
			env.ANTHROPIC_BASE_URL = this.config.baseURL;
		}
		if (Object.keys(env).length > 0) options.env = env;

		if (this.mcpServers !== undefined) options.mcpServers = this.mcpServers;

		return options;
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const q = query({ prompt: opts.prompt, options: this.buildOptions(opts) });
		let text = "";
		let raw: unknown;
		for await (const message of q) {
			if (message.type === "result") {
				raw = message;
				if (message.subtype === "success") text = message.result;
				break;
			}
		}
		return { text, kind: this.kind, raw };
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const q = query({
					prompt: opts.prompt,
					options: self.buildOptions(opts),
				});
				for await (const message of q) {
					if (message.type !== "assistant") continue;
					const delta = extractTextBlocks(message.message.content);
					if (delta.length === 0) continue;
					yield { kind: self.kind, delta, raw: message };
				}
			},
		};
	}
}
