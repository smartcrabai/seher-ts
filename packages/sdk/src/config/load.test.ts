import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./defaults.ts";
import { ConfigLoadError, loadConfig, parseConfigText } from "./load.ts";

async function makeTmpFile(name: string, body: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "seher-config-"));
	const path = join(dir, name);
	await writeFile(path, body, "utf8");
	return path;
}

describe("loadConfig / parseConfigText", () => {
	test("defaultConfig returns empty providers", () => {
		expect(defaultConfig()).toEqual({ providers: [] });
	});

	test("explicit path: missing file falls back to defaults", async () => {
		const cfg = await loadConfig("/tmp/definitely-not-there-seher.yaml");
		expect(cfg).toEqual(defaultConfig());
	});

	test("parses Notion-spec example YAML", async () => {
		const yaml = `
providers:
  codex:
    models:
      plan: { model: gpt-5.5, priority: 5 }
      build: { model: gpt-5.5, priority: 4 }
  claude:
    priority: 3
    models:
      plan: opus-4.7
      build: sonnet-4.6
      low: haiku-4.5
  zai:
    sdk: claude
    api:
      key: sk-za-xxxxxxxxxxxxx
      endpoint: https://xxxxx
    models:
      plan: glm-5.1
      build: glm-5.1
`;
		const path = await makeTmpFile("config.yaml", yaml);
		const cfg = await loadConfig(path);
		expect(cfg.providers.map((p) => p.key)).toEqual(["codex", "claude", "zai"]);
		const claude = cfg.providers.find((p) => p.key === "claude");
		expect(claude?.priority).toBe(3);
		expect(claude?.models.low).toEqual({ model: "haiku-4.5" });
		const zai = cfg.providers.find((p) => p.key === "zai");
		expect(zai?.sdk).toBe("claude");
		expect(zai?.api?.endpoint).toBe("https://xxxxx");
	});

	test("empty YAML returns default config", () => {
		expect(parseConfigText("", "inline")).toEqual(defaultConfig());
		expect(parseConfigText("\n\n", "inline")).toEqual(defaultConfig());
	});

	test("malformed YAML surfaces ConfigLoadError", () => {
		expect(() =>
			parseConfigText("providers:\n  claude:\n  - bad", "inline"),
		).toThrow(ConfigLoadError);
	});

	test("invalid config (missing models) surfaces ConfigLoadError", () => {
		expect(() =>
			parseConfigText("providers:\n  claude:\n    priority: 1\n", "inline"),
		).toThrow(ConfigLoadError);
	});
});
