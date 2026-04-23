import { describe, expect, test } from "bun:test";
import { editPromptInEditor, resolvePrompt } from "./prompt.ts";

describe("resolvePrompt", () => {
	test("returns trailing joined when non-empty", async () => {
		const result = await resolvePrompt({
			trailing: ["hello", "world"],
			readStream: async () => "",
		});
		expect(result).toBe("hello world");
	});

	test("returns stdin content when trailing is empty", async () => {
		const result = await resolvePrompt({
			trailing: [],
			readStream: async () => "  from stdin  \n",
			editorFallback: false,
		});
		expect(result).toBe("from stdin");
	});

	test("returns null when stdin empty and editor fallback disabled", async () => {
		const result = await resolvePrompt({
			trailing: [],
			readStream: async () => "",
			editorFallback: false,
		});
		expect(result).toBeNull();
	});

	test("invokes editor when stdin empty and TTY", async () => {
		let editorCalled = false;
		const result = await resolvePrompt({
			trailing: [],
			readStream: async () => "",
			isStdinTty: true,
			editorFallback: true,
			runEditor: async () => {
				editorCalled = true;
				return "edited prompt";
			},
		});
		expect(editorCalled).toBe(true);
		expect(result).toBe("edited prompt");
	});

	test("does not invoke editor when not a TTY", async () => {
		let editorCalled = false;
		const result = await resolvePrompt({
			trailing: [],
			readStream: async () => "",
			isStdinTty: false,
			runEditor: async () => {
				editorCalled = true;
				return "nope";
			},
		});
		expect(editorCalled).toBe(false);
		expect(result).toBeNull();
	});

	test("returns null when editor returns empty string", async () => {
		const result = await resolvePrompt({
			trailing: [],
			readStream: async () => "",
			isStdinTty: true,
			runEditor: async () => "",
		});
		expect(result).toBeNull();
	});
});

describe("editPromptInEditor", () => {
	test("launches $EDITOR (smoke via /bin/cat)", async () => {
		const prev = process.env.EDITOR;
		process.env.EDITOR = "/bin/cat";
		try {
			const result = await editPromptInEditor("seed content");
			// /bin/cat reads the tmp file and writes to stdout; the file is unchanged,
			// so trim should yield the original seed.
			expect(result).toBe("seed content");
		} finally {
			if (prev === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = prev;
		}
	});
});
