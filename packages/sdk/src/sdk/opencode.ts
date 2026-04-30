import {
	createOpencode,
	createOpencodeClient,
	type OpencodeClient,
	type Config as OpencodeConfig,
} from "@opencode-ai/sdk";
import { extractTextBlocks } from "./text.ts";
import type {
	SdkKind,
	SeherRunOptions,
	SeherRunResult,
	SeherSDKInstance,
	SeherStreamChunk,
} from "./types.ts";

export interface OpencodeSDKConfig {
	/**
	 * Connect to an existing OpenCode server at this URL. When set, no server
	 * is spawned. Mutually exclusive with `hostname`/`port`.
	 */
	baseURL?: string;
	/** Headers passed to the underlying hey-api client (e.g. for basic auth). */
	headers?: Record<string, string>;
	/** Hostname for an auto-spawned server (default: 127.0.0.1). */
	hostname?: string;
	/** Port for an auto-spawned server. */
	port?: number;
	/** Inline opencode configuration overrides for an auto-spawned server. */
	config?: OpencodeConfig;
	/** Working directory passed to the client (forwarded as `?directory=`). */
	directory?: string;
	/**
	 * Default model in `"providerID/modelID"` form. The single-string `model`
	 * passed to `run()` is parsed the same way; if it has no `/`, the provider
	 * falls back to `defaultProviderID`.
	 */
	defaultModel?: string;
	defaultProviderID?: string;
	/** Optional agent name forwarded to `session.prompt` (e.g. `"build"`). */
	agent?: string;
}

const DEFAULT_PROVIDER_ID = "anthropic";
const DEFAULT_MODEL_ID = "claude-sonnet-4-20250514";

// seher-ts delegates safety to the caller, so default to maximally permissive.
const DEFAULT_PERMISSION = {
	edit: "allow",
	bash: "allow",
	webfetch: "allow",
	doom_loop: "allow",
	external_directory: "allow",
} as const satisfies NonNullable<OpencodeConfig["permission"]>;

function parseModel(
	model: string,
	fallbackProvider: string,
): { providerID: string; modelID: string } {
	const slash = model.indexOf("/");
	if (slash > 0) {
		return {
			providerID: model.slice(0, slash),
			modelID: model.slice(slash + 1),
		};
	}
	return { providerID: fallbackProvider, modelID: model };
}

type SpawnedServer = { url: string; close(): void };

/**
 * OpenCode SDK runner.
 *
 * When no `baseURL` is provided, the constructor lazily spawns a local
 * opencode server via `createOpencode` on the first `run()` / `stream()`.
 * That server is owned by this instance and **must be released by calling
 * `close()` (or `await using` via `[Symbol.asyncDispose]`)** — otherwise
 * the child process leaks until the parent exits.
 *
 * `stream()` is currently a buffered shim: it runs the prompt to completion
 * and yields a single chunk with the final text. The opencode SDK exposes
 * SSE via `client.event.subscribe()` for true incremental streaming; wiring
 * that up is a follow-up.
 */
export class OpencodeSDK implements SeherSDKInstance {
	readonly kind: SdkKind = "opencode";
	private readonly config: OpencodeSDKConfig;
	private _client: OpencodeClient | null = null;
	private _server: SpawnedServer | null = null;
	private _starting: Promise<OpencodeClient> | null = null;

	constructor(config: OpencodeSDKConfig = {}) {
		this.config = config;
	}

	private async getClient(): Promise<OpencodeClient> {
		if (this._client !== null) return this._client;
		if (this._starting !== null) return this._starting;
		this._starting = (async () => {
			if (this.config.baseURL !== undefined) {
				const opts: {
					baseUrl: string;
					headers?: Record<string, string>;
					directory?: string;
				} = { baseUrl: this.config.baseURL };
				if (this.config.headers !== undefined)
					opts.headers = this.config.headers;
				if (this.config.directory !== undefined)
					opts.directory = this.config.directory;
				const client = createOpencodeClient(opts);
				this._client = client;
				return client;
			}
			type CreateOpencodeOptions = NonNullable<
				Parameters<typeof createOpencode>[0]
			>;
			const startOpts: CreateOpencodeOptions = {};
			if (this.config.hostname !== undefined)
				startOpts.hostname = this.config.hostname;
			if (this.config.port !== undefined) startOpts.port = this.config.port;
			const userConfig = this.config.config ?? {};
			startOpts.config = {
				...userConfig,
				permission: userConfig.permission ?? DEFAULT_PERMISSION,
			};
			const result = await createOpencode(startOpts);
			this._client = result.client;
			this._server = result.server;
			return result.client;
		})();
		try {
			return await this._starting;
		} finally {
			this._starting = null;
		}
	}

	private buildModel(opts: SeherRunOptions): {
		providerID: string;
		modelID: string;
	} {
		const fallbackProvider =
			this.config.defaultProviderID ?? DEFAULT_PROVIDER_ID;
		if (opts.model !== undefined)
			return parseModel(opts.model, fallbackProvider);
		if (this.config.defaultModel !== undefined) {
			return parseModel(this.config.defaultModel, fallbackProvider);
		}
		return { providerID: fallbackProvider, modelID: DEFAULT_MODEL_ID };
	}

	private async startSession(): Promise<{
		client: OpencodeClient;
		sessionID: string;
	}> {
		const client = await this.getClient();
		const created = await client.session.create();
		const sessionID = created.data?.id;
		if (sessionID === undefined) {
			throw new Error("opencode session.create returned no session id");
		}
		return { client, sessionID };
	}

	async run(opts: SeherRunOptions): Promise<SeherRunResult> {
		const { client, sessionID } = await this.startSession();
		const body: {
			model: { providerID: string; modelID: string };
			parts: Array<{ type: "text"; text: string }>;
			system?: string;
			agent?: string;
		} = {
			model: this.buildModel(opts),
			parts: [{ type: "text", text: opts.prompt }],
		};
		if (opts.systemPrompt !== undefined) body.system = opts.systemPrompt;
		if (this.config.agent !== undefined) body.agent = this.config.agent;
		try {
			const result = await client.session.prompt({
				path: { id: sessionID },
				body,
			});
			const text = extractTextBlocks(result.data?.parts);
			return { text, kind: this.kind, raw: result };
		} finally {
			await client.session.delete({ path: { id: sessionID } }).catch(() => {});
		}
	}

	stream(opts: SeherRunOptions): AsyncIterable<SeherStreamChunk> {
		const self = this;
		return {
			async *[Symbol.asyncIterator]() {
				const result = await self.run(opts);
				yield { kind: self.kind, delta: result.text, raw: result.raw };
			},
		};
	}

	/** Stop a server spawned by this SDK instance, if any. */
	async close(): Promise<void> {
		// Wait for any in-flight spawn so we don't leak a server that finishes
		// starting after close() returns.
		const starting = this._starting;
		if (starting !== null) await starting.catch(() => {});
		const server = this._server;
		this._server = null;
		this._client = null;
		if (server !== null) server.close();
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.close();
	}
}
