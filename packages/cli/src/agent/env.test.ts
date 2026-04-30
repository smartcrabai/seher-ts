import { expect, test } from "bun:test";
import { buildEnv } from "./env.ts";

test("buildEnv merges base and agent env entries", () => {
	const out = buildEnv({ PATH: "/usr/bin", FOO: "a" }, { FOO: "b", BAR: "c" });
	expect(out).toEqual({ PATH: "/usr/bin", FOO: "b", BAR: "c" });
});

test("buildEnv drops undefined values from the base", () => {
	const out = buildEnv({ PATH: "/usr/bin", NADA: undefined }, null);
	expect(out).toEqual({ PATH: "/usr/bin" });
	expect(Object.hasOwn(out, "NADA")).toBe(false);
});

test("buildEnv returns a plain copy when agentEnv is null", () => {
	const out = buildEnv({ PATH: "/usr/bin" }, null);
	expect(out).toEqual({ PATH: "/usr/bin" });
});
