import { describe, expect, test } from "bun:test";
import { ConfigValidationError, validateConfig } from "./validate.ts";

describe("validateConfig", () => {
	test("empty/missing providers yields empty config", () => {
		expect(validateConfig({})).toEqual({ providers: [] });
		expect(validateConfig({ providers: {} })).toEqual({ providers: [] });
	});

	test("built-in provider with shorthand string model", () => {
		const cfg = validateConfig({
			providers: {
				claude: {
					priority: 3,
					models: { plan: "opus-4.7", build: "sonnet-4.6" },
				},
			},
		});
		expect(cfg.providers).toHaveLength(1);
		const claude = cfg.providers[0];
		expect(claude?.key).toBe("claude");
		expect(claude?.sdk).toBe("claude");
		expect(claude?.priority).toBe(3);
		expect(claude?.models.plan).toEqual({ model: "opus-4.7" });
		expect(claude?.models.build).toEqual({ model: "sonnet-4.6" });
	});

	test("model object with explicit priority", () => {
		const cfg = validateConfig({
			providers: {
				codex: {
					models: {
						plan: { model: "gpt-5.5", priority: 5 },
						build: { model: "gpt-5.5", priority: 4 },
					},
				},
			},
		});
		const codex = cfg.providers[0];
		expect(codex?.sdk).toBe("codex");
		expect(codex?.models.plan).toEqual({ model: "gpt-5.5", priority: 5 });
		expect(codex?.models.build).toEqual({ model: "gpt-5.5", priority: 4 });
	});

	test("non-builtin provider requires sdk and api", () => {
		expect(() =>
			validateConfig({
				providers: { zai: { models: { build: "glm-5.1" } } },
			}),
		).toThrow(/sdk is required/);
		expect(() =>
			validateConfig({
				providers: { zai: { sdk: "claude", models: { build: "glm-5.1" } } },
			}),
		).toThrow(/api is required/);
	});

	test("non-builtin provider with full config parses", () => {
		const cfg = validateConfig({
			providers: {
				zai: {
					sdk: "claude",
					api: { key: "sk-za-xxxxx", endpoint: "https://api.zai.test" },
					models: { plan: "glm-5.1", build: "glm-5.1" },
				},
			},
		});
		const zai = cfg.providers[0];
		expect(zai?.sdk).toBe("claude");
		expect(zai?.api).toEqual({
			key: "sk-za-xxxxx",
			endpoint: "https://api.zai.test",
		});
	});

	test("invalid sdk value rejected", () => {
		expect(() =>
			validateConfig({
				providers: { claude: { sdk: "bogus", models: { build: "x" } } },
			}),
		).toThrow(ConfigValidationError);
	});

	test("missing models map fails", () => {
		expect(() =>
			validateConfig({
				providers: { claude: { priority: 1 } },
			}),
		).toThrow(/models is required/);
	});

	test("provider entry insertion order is preserved", () => {
		const cfg = validateConfig({
			providers: {
				codex: { models: { build: "x" } },
				claude: { models: { build: "y" } },
				cursor: { models: { build: "z" } },
			},
		});
		expect(cfg.providers.map((p) => p.key)).toEqual([
			"codex",
			"claude",
			"cursor",
		]);
		expect(cfg.providers.map((p) => p.order)).toEqual([0, 1, 2]);
	});

	test("priority must be a finite number", () => {
		expect(() =>
			validateConfig({
				providers: {
					claude: { priority: "high", models: { build: "x" } },
				},
			}),
		).toThrow(/priority must be a finite number/);
	});

	test("model entry priority must be finite", () => {
		expect(() =>
			validateConfig({
				providers: {
					claude: {
						models: { build: { model: "x", priority: Number.NaN } },
					},
				},
			}),
		).toThrow(/priority must be a finite number/);
	});

	test("opencodego maps to opencode SDK", () => {
		const cfg = validateConfig({
			providers: { opencodego: { models: { build: "anthropic/sonnet" } } },
		});
		expect(cfg.providers[0]?.sdk).toBe("opencode");
	});
});
