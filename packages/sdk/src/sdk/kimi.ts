import { createExternalTool, createSession } from "@moonshot-ai/kimi-agent-sdk";
import type { z } from "zod";
import { joinSystemPrompt } from "./text.ts";
import type { SeherTool } from "./tools.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

export interface KimiSDKConfig {
	workDir?: string;
	defaultModel?: string;
	thinking?: boolean;
	yoloMode?: boolean;
	executable?: string;
	env?: Record<string, string>;
	/**
	 * In-process tools registered via SeherSDK. Forwarded to the Kimi session
	 * as `externalTools`.
	 */
	tools?: SeherTool<z.ZodObject<z.ZodRawShape>>[];
}

function toKimiTool(t: SeherTool<z.ZodObject<z.ZodRawShape>>) {
	return createExternalTool({
		name: t.name,
		description: t.description,
		parameters: t.parameters,
		handler: async (params) => {
			const out = await t.handler(params as never);
			return { output: out, message: out };
		},
	});
}

type KimiSession = {
	prompt: (content: string) => KimiTurn;
	close: () => Promise<void>;
};

type KimiEvent = {
	type?: string;
	payload?: { type?: string; text?: string } & Record<string, unknown>;
};

type KimiTurn = AsyncIterable<KimiEvent> & {
	readonly result: Promise<unknown>;
};

export class KimiSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "kimi";
	private readonly config: KimiSDKConfig;
	private readonly externalTools: ReturnType<typeof toKimiTool>[] | undefined;

	constructor(config: KimiSDKConfig = {}) {
		this.config = config;
		this.externalTools =
			config.tools !== undefined && config.tools.length > 0
				? config.tools.map(toKimiTool)
				: undefined;
	}

	private buildSessionOptions(opts: SeherRunOptions): Record<string, unknown> {
		const sessionOpts: Record<string, unknown> = {
			workDir: this.config.workDir ?? process.cwd(),
			yoloMode: this.config.yoloMode ?? true,
		};
		const model = opts.model ?? this.config.defaultModel;
		if (model !== undefined) sessionOpts.model = model;
		if (this.config.thinking !== undefined)
			sessionOpts.thinking = this.config.thinking;
		if (this.config.executable !== undefined)
			sessionOpts.executable = this.config.executable;
		if (this.config.env !== undefined) sessionOpts.env = this.config.env;
		if (this.externalTools !== undefined) {
			sessionOpts.externalTools = this.externalTools;
		}
		return sessionOpts;
	}

	private startTurn(opts: SeherRunOptions): {
		session: KimiSession;
		turn: KimiTurn;
	} {
		const sessionOpts = this.buildSessionOptions(opts) as unknown as Parameters<
			typeof createSession
		>[0];
		const session = createSession(sessionOpts) as unknown as KimiSession;
		const turn = session.prompt(joinSystemPrompt(opts));
		return { session, turn };
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const { session, turn } = this.startTurn(opts);
		const parts: string[] = [];
		try {
			for await (const event of turn) {
				if (
					event.type === "ContentPart" &&
					event.payload?.type === "text" &&
					typeof event.payload.text === "string"
				) {
					parts.push(event.payload.text);
				}
			}
			const result = await turn.result;
			return { text: parts.join(""), kind: this.kind, raw: result };
		} finally {
			await session.close();
		}
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const { session, turn } = self.startTurn(opts);
				try {
					for await (const event of turn) {
						let delta = "";
						if (
							event.type === "ContentPart" &&
							event.payload?.type === "text" &&
							typeof event.payload.text === "string"
						) {
							delta = event.payload.text;
						}
						yield { kind: self.kind, delta, raw: event };
					}
				} finally {
					await session.close();
				}
			},
		};
	}
}
