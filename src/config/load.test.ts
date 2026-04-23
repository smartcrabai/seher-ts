import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "./defaults.ts";
import { ConfigLoadError, loadSettings, parseSettingsText } from "./load.ts";

async function makeTmpFile(name: string, body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "seher-config-"));
	const path = join(dir, name);
	await writeFile(path, body, "utf8");
	return path;
}

describe("loadSettings / parseSettingsText", () => {
	test("defaultSettings returns empty config", () => {
		expect(defaultSettings()).toEqual({ agents: [], priority: [] });
	});

	test("explicit path: missing file falls back to defaults", async () => {
		const s = await loadSettings("/tmp/definitely-not-there-seher.jsonc");
		expect(s).toEqual(defaultSettings());
	});

	test("explicit path: minimal JSON fixture parses", async () => {
		const path = await makeTmpFile(
			"settings.json",
			JSON.stringify({ agents: [{ command: "claude" }] }),
		);
		const s = await loadSettings(path);
		expect(s.agents[0]?.command).toBe("claude");
	});

	test("JSONC: trailing commas and comments", async () => {
		const jsonc = `{
	// top-level comment
	"agents": [
		{
			"command": "claude", // inline comment
			"args": ["--model", "{model}",],
		},
		/* block comment */
		{
			"command": "codex",
		},
	],
}`;
		const path = await makeTmpFile("settings.jsonc", jsonc);
		const s = await loadSettings(path);
		expect(s.agents).toHaveLength(2);
		expect(s.agents[0]?.args).toEqual(["--model", "{model}"]);
		expect(s.agents[1]?.command).toBe("codex");
	});

	test("parseSettingsText surfaces invalid active+inactive via ConfigLoadError", () => {
		const text = JSON.stringify({
			agents: [
				{
					command: "claude",
					active: { hours: ["9-17"] },
					inactive: { hours: ["0-8"] },
				},
			],
		});
		expect(() => parseSettingsText(text, "inline")).toThrow(ConfigLoadError);
		expect(() => parseSettingsText(text, "inline")).toThrow(
			/cannot have both active and inactive/,
		);
	});

	test("parseSettingsText surfaces invalid weekday '1-8'", () => {
		const text = JSON.stringify({
			agents: [{ command: "claude", active: { weekdays: ["1-8"] } }],
		});
		expect(() => parseSettingsText(text, "inline")).toThrow(
			/end must not exceed 6/,
		);
	});

	test("parseSettingsText surfaces invalid weekday '5-3'", () => {
		const text = JSON.stringify({
			agents: [{ command: "claude", active: { weekdays: ["5-3"] } }],
		});
		expect(() => parseSettingsText(text, "inline")).toThrow(
			/start must not exceed end/,
		);
	});

	test("parseSettingsText surfaces invalid hour range '0-49'", () => {
		const text = JSON.stringify({
			agents: [{ command: "claude", active: { hours: ["0-49"] } }],
		});
		expect(() => parseSettingsText(text, "inline")).toThrow(
			/end must not exceed 48/,
		);
	});

	test("parseSettingsText rejects malformed JSONC", () => {
		expect(() => parseSettingsText("{ not json", "inline")).toThrow(
			ConfigLoadError,
		);
	});
});
