import { expect, test } from "bun:test";
import { applyArgMaps, resolveArgs } from "./args.ts";

test("resolveArgs substitutes {model} using the models map", () => {
	const out = resolveArgs(["--model", "{model}"], "high", { high: "opus" });
	expect(out).toEqual(["--model", "opus"]);
});

test("resolveArgs removes the --model/{model} pair when no model is selected", () => {
	const out = resolveArgs(["--model", "{model}"], undefined, { high: "opus" });
	expect(out).toEqual([]);
});

test("resolveArgs falls back to the model key when no mapping exists", () => {
	const out = resolveArgs(["--model", "{model}"], "medium", { high: "opus" });
	expect(out).toEqual(["--model", "medium"]);
});

test("resolveArgs passes --model <value> through when models map is null", () => {
	const out = resolveArgs([], "high", null);
	expect(out).toEqual(["--model", "high"]);
});

test("resolveArgs does not duplicate --model when template already contains {model} and models map is null", () => {
	const out = resolveArgs(["--model", "{model}"], "high", null);
	expect(out).toEqual(["--model", "high"]);
});

test("resolveArgs leaves args untouched when no model is selected and template has no placeholder", () => {
	const out = resolveArgs(["--foo", "bar"], undefined, { high: "opus" });
	expect(out).toEqual(["--foo", "bar"]);
});

test("resolveArgs only drops the placeholder when the preceding arg is not a flag", () => {
	const out = resolveArgs(["keep", "{model}"], undefined, { high: "opus" });
	expect(out).toEqual(["keep"]);
});

test("applyArgMaps expands mapped tokens to multiple args", () => {
	const out = applyArgMaps(["--danger"], {
		"--danger": ["--permission-mode", "bypassPermissions"],
	});
	expect(out).toEqual(["--permission-mode", "bypassPermissions"]);
});

test("applyArgMaps passes unmatched tokens through unchanged", () => {
	const out = applyArgMaps(["--other", "fix bugs"], {
		"--danger": ["--yolo"],
	});
	expect(out).toEqual(["--other", "fix bugs"]);
});

test("applyArgMaps preserves order when mixing mapped and unmapped tokens", () => {
	const out = applyArgMaps(["--danger", "fix bugs"], {
		"--danger": ["--yolo"],
	});
	expect(out).toEqual(["--yolo", "fix bugs"]);
});
