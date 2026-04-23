import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSchema, getSettings, putSettings } from "./routes.ts";
import { createServer } from "./server.ts";
import { validateSettings } from "./validate.ts";

let tmp: string;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "seher-web-"));
});

afterEach(async () => {
	await rm(tmp, { recursive: true, force: true });
});

describe("validateSettings", () => {
	test("accepts empty object", () => {
		expect(validateSettings({})).toEqual({ ok: true, value: {} });
	});

	test("rejects non-object", () => {
		const result = validateSettings(42);
		expect(result.ok).toBe(false);
	});

	test("rejects unknown top-level key", () => {
		const result = validateSettings({ unexpected: 1 });
		expect(result.ok).toBe(false);
	});

	test("rejects non-array agents", () => {
		const result = validateSettings({ agents: {} });
		expect(result.ok).toBe(false);
	});

	test("accepts agents and priority arrays", () => {
		const result = validateSettings({ agents: [], priority: [] });
		expect(result.ok).toBe(true);
	});
});

describe("getSettings", () => {
	test("returns existing JSON file", async () => {
		const path = join(tmp, "settings.json");
		const data = { agents: [{ name: "a" }] };
		await Bun.write(path, JSON.stringify(data));
		const res = await getSettings(path);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(data);
	});

	test("returns 404 when file is missing", async () => {
		const res = await getSettings(join(tmp, "missing.json"));
		expect(res.status).toBe(404);
	});

	test("returns 500 on malformed JSON", async () => {
		const path = join(tmp, "bad.json");
		await Bun.write(path, "{ not json");
		const res = await getSettings(path);
		expect(res.status).toBe(500);
	});
});

describe("putSettings", () => {
	test("writes valid body", async () => {
		const path = join(tmp, "settings.json");
		await Bun.write(path, "{}");
		const body = JSON.stringify({ agents: [{ name: "a" }] });
		const req = new Request("http://x/api/settings", {
			method: "PUT",
			body,
		});
		const res = await putSettings(req, path);
		expect(res.status).toBe(200);
		const written = JSON.parse(await Bun.file(path).text());
		expect(written).toEqual({ agents: [{ name: "a" }] });
	});

	test("rejects invalid JSON with 400", async () => {
		const path = join(tmp, "settings.json");
		await Bun.write(path, "{}");
		const req = new Request("http://x/api/settings", {
			method: "PUT",
			body: "{ not json",
		});
		const res = await putSettings(req, path);
		expect(res.status).toBe(400);
	});

	test("rejects unknown top-level keys with 400", async () => {
		const path = join(tmp, "settings.json");
		await Bun.write(path, "{}");
		const req = new Request("http://x/api/settings", {
			method: "PUT",
			body: JSON.stringify({ bogus: 1 }),
		});
		const res = await putSettings(req, path);
		expect(res.status).toBe(400);
	});
});

describe("getSchema", () => {
	test("returns schema when file exists", async () => {
		const path = join(tmp, "schema.json");
		const schema = { $schema: "http://json-schema.org/draft-07/schema#" };
		await Bun.write(path, JSON.stringify(schema));
		const res = await getSchema(path);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(schema);
	});

	test("returns 404 when schema missing", async () => {
		const res = await getSchema(join(tmp, "missing.json"));
		expect(res.status).toBe(404);
	});
});

describe("createServer smoke test", () => {
	test("serves HTML index and routes", async () => {
		const settingsPath = join(tmp, "settings.json");
		await Bun.write(settingsPath, JSON.stringify({ agents: [] }));
		const server = createServer({ settingsPath, port: 0 });
		try {
			const base = `http://localhost:${server.port}`;
			const rootRes = await fetch(base);
			expect(rootRes.status).toBe(200);
			expect(rootRes.headers.get("content-type")).toContain("text/html");
			const html = await rootRes.text();
			expect(html).toContain("seher config editor");

			const getRes = await fetch(`${base}/api/settings`);
			expect(getRes.status).toBe(200);
			expect(await getRes.json()).toEqual({ agents: [] });

			const putRes = await fetch(`${base}/api/settings`, {
				method: "PUT",
				body: JSON.stringify({ agents: [{ name: "x" }] }),
			});
			expect(putRes.status).toBe(200);
			const written = JSON.parse(await Bun.file(settingsPath).text());
			expect(written).toEqual({ agents: [{ name: "x" }] });
		} finally {
			server.stop(true);
		}
	});
});
