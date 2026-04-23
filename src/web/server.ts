import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSchema, getSettings, putSettings } from "./routes.ts";

export type StartWebServerOptions = {
	settingsPath: string;
	port?: number;
	openBrowser?: boolean;
	schemaPath?: string;
	indexHtmlPath?: string;
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_INDEX_HTML = join(MODULE_DIR, "public", "index.html");
const DEFAULT_SCHEMA_PATH = join(
	MODULE_DIR,
	"..",
	"..",
	"schemas",
	"settings.schema.json",
);

export function createServer(opts: StartWebServerOptions) {
	const indexHtmlPath = opts.indexHtmlPath ?? DEFAULT_INDEX_HTML;
	const schemaPath = opts.schemaPath ?? DEFAULT_SCHEMA_PATH;
	return Bun.serve({
		port: opts.port ?? 0,
		routes: {
			"/": () =>
				new Response(Bun.file(indexHtmlPath), {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
			"/api/settings": {
				GET: () => getSettings(opts.settingsPath),
				PUT: (req) => putSettings(req, opts.settingsPath),
			},
			"/api/schema": {
				GET: () => getSchema(schemaPath),
			},
		},
		fetch() {
			return new Response("not found", { status: 404 });
		},
	});
}

export async function startWebServer(
	opts: StartWebServerOptions,
): Promise<void> {
	const server = createServer(opts);
	const url = `http://localhost:${server.port}`;
	console.log(`seher config editor at ${url}`);
	if (opts.openBrowser) {
		try {
			Bun.spawn(["open", url]);
		} catch {
			// ignore browser-open failures
		}
	}
	return new Promise<void>(() => {
		// intentionally pending; server runs until the process is stopped
	});
}
