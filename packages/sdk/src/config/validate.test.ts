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

	test("claude-terminal is a built-in provider that maps to claude-terminal SDK", () => {
		const cfg = validateConfig({
			providers: {
				"claude-terminal": { models: { build: "claude-opus-4-7" } },
			},
		});
		const entry = cfg.providers[0];
		expect(entry?.provider).toBe("claude-terminal");
		expect(entry?.sdk).toBe("claude-terminal");
	});

	test("explicit sdk: claude-terminal passes validation (api required for non-builtin)", () => {
		const cfg = validateConfig({
			providers: {
				"my-claude-terminal": {
					sdk: "claude-terminal",
					api: { key: "sk-ct" },
					models: { build: "claude-opus-4-7" },
				},
			},
		});
		expect(cfg.providers[0]?.sdk).toBe("claude-terminal");
	});

	test("provider defaults to YAML key when omitted", () => {
		const cfg = validateConfig({
			providers: { claude: { models: { build: "sonnet" } } },
		});
		const entry = cfg.providers[0];
		expect(entry?.key).toBe("claude");
		expect(entry?.provider).toBe("claude");
	});

	test("explicit provider overrides YAML key for SDK default lookup", () => {
		const cfg = validateConfig({
			providers: {
				"my-claude": {
					provider: "claude",
					priority: 5,
					models: { build: "opus-4.7" },
				},
			},
		});
		const entry = cfg.providers[0];
		expect(entry?.key).toBe("my-claude");
		expect(entry?.provider).toBe("claude");
		expect(entry?.sdk).toBe("claude");
	});

	test("non-builtin resolved provider still requires sdk + api", () => {
		expect(() =>
			validateConfig({
				providers: {
					"my-zai": { provider: "zai", models: { build: "glm-5.1" } },
				},
			}),
		).toThrow(/sdk is required/);
		expect(() =>
			validateConfig({
				providers: {
					"my-zai": {
						provider: "zai",
						sdk: "claude",
						models: { build: "glm-5.1" },
					},
				},
			}),
		).toThrow(/api is required/);
	});

	test("provider must be a non-empty string when specified", () => {
		expect(() =>
			validateConfig({
				providers: { claude: { provider: "", models: { build: "sonnet" } } },
			}),
		).toThrow(/provider must be a non-empty string/);
		expect(() =>
			validateConfig({
				providers: { claude: { provider: 42, models: { build: "sonnet" } } },
			}),
		).toThrow(/provider must be a non-empty string/);
	});

	test("YAML key may differ from provider for codexbar sharing", () => {
		const cfg = validateConfig({
			providers: {
				"claude-primary": {
					provider: "claude",
					priority: 5,
					models: { build: "opus-4.7" },
				},
				"claude-secondary": {
					provider: "claude",
					priority: 1,
					models: { build: "sonnet-4.6" },
				},
			},
		});
		expect(cfg.providers.map((p) => p.key)).toEqual([
			"claude-primary",
			"claude-secondary",
		]);
		expect(cfg.providers.map((p) => p.provider)).toEqual(["claude", "claude"]);
	});

	test("pi: no default SDK mapping — explicit sdk: pi is required", () => {
		expect(() =>
			validateConfig({
				providers: { pi: { models: { build: "anthropic/claude-sonnet-4-5" } } },
			}),
		).toThrow(/sdk is required/);
	});

	test("pi: explicit sdk: pi passes validation (api required for non-builtin)", () => {
		const cfg = validateConfig({
			providers: {
				pi: {
					sdk: "pi",
					api: { key: "sk-test" },
					models: { build: "anthropic/claude-sonnet-4-5" },
				},
			},
		});
		expect(cfg.providers).toHaveLength(1);
		const entry = cfg.providers[0];
		expect(entry?.key).toBe("pi");
		expect(entry?.sdk).toBe("pi");
	});

	test("pi: explicit sdk: pi with full api config passes", () => {
		const cfg = validateConfig({
			providers: {
				"my-pi-endpoint": {
					sdk: "pi",
					api: { key: "sk-xxxxx", endpoint: "https://api.example.com" },
					models: { build: "anthropic/claude-sonnet-4-5" },
				},
			},
		});
		expect(cfg.providers).toHaveLength(1);
		const entry = cfg.providers[0];
		expect(entry?.key).toBe("my-pi-endpoint");
		expect(entry?.sdk).toBe("pi");
		expect(entry?.api).toEqual({
			key: "sk-xxxxx",
			endpoint: "https://api.example.com",
		});
	});

	test("pi: custom map key with sdk: pi and api works", () => {
		const cfg = validateConfig({
			providers: {
				mypi: {
					sdk: "pi",
					api: { key: "sk-test" },
					models: { build: "openai/gpt-5" },
				},
			},
		});
		expect(cfg.providers[0]?.key).toBe("mypi");
		expect(cfg.providers[0]?.provider).toBe("mypi");
		expect(cfg.providers[0]?.sdk).toBe("pi");
	});

	test("root skills.includeClaude parses", () => {
		const cfg = validateConfig({
			skills: { includeClaude: false },
			providers: { claude: { models: { build: "sonnet" } } },
		});
		expect(cfg.skills).toEqual({ includeClaude: false });
	});

	test("provider-level skills override is parsed and preserved separately", () => {
		const cfg = validateConfig({
			skills: { includeClaude: true },
			providers: {
				mypi: {
					sdk: "pi",
					api: { key: "sk" },
					skills: { includeClaude: false },
					models: { build: "openai/gpt-5" },
				},
			},
		});
		expect(cfg.skills).toEqual({ includeClaude: true });
		expect(cfg.providers[0]?.skills).toEqual({ includeClaude: false });
	});

	test("skills.includeClaude must be a boolean", () => {
		expect(() =>
			validateConfig({
				skills: { includeClaude: "yes" },
				providers: {},
			}),
		).toThrow(/includeClaude must be a boolean/);
		expect(() =>
			validateConfig({
				providers: {
					mypi: {
						sdk: "pi",
						api: { key: "sk" },
						skills: { includeClaude: 1 },
						models: { build: "x" },
					},
				},
			}),
		).toThrow(/includeClaude must be a boolean/);
	});

	test("skills section omitted yields undefined skills", () => {
		const cfg = validateConfig({
			providers: { claude: { models: { build: "sonnet" } } },
		});
		expect(cfg.skills).toBeUndefined();
		expect(cfg.providers[0]?.skills).toBeUndefined();
	});
});
