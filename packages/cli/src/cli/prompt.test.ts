import { describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import {
	editPromptInEditor,
	ensureEditorAvailable,
	resolvePrompt,
} from "./prompt.ts";

function hasControllingTty(): boolean {
	if (process.platform === "win32") {
		return process.stdin.isTTY === true && process.stdout.isTTY === true;
	}
	try {
		const fd = openSync("/dev/tty", "r+");
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

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
			editorFallback: true,
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
			editorFallback: true,
			runEditor: async () => "",
		});
		expect(result).toBeNull();
	});
});

describe("ensureEditorAvailable", () => {
	// This is environment-dependent (whether a controlling terminal exists),
	// so we only verify that neither Ok nor Err path panics.
	test("is callable without crashing (smoke)", () => {
		let threw = false;
		try {
			ensureEditorAvailable();
		} catch (err) {
			threw = true;
			// On failure, the message should match the Rust version for greppability.
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain(
				"seher is not running in the foreground terminal",
			);
		}
		// Whether it throws depends on the environment, so don't assert on it.
		expect(typeof threw).toBe("boolean");
	});
});

describe("editPromptInEditor", () => {
	// In environments without a controlling terminal (e.g. CI), `/dev/tty`
	// can't be opened, so it can't be passed to the editor child process's
	// stdio and always fails. As with the Rust version's tests, this is a
	// "smoke test that only runs when a TTY is present".
	test.skipIf(!hasControllingTty())(
		"launches $EDITOR (smoke via /bin/cat)",
		async () => {
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
		},
	);

	// Without a controlling terminal, `ensureEditorAvailable()` should error immediately.
	test.skipIf(hasControllingTty())(
		"throws foreground-terminal error when no controlling tty",
		async () => {
			await expect(editPromptInEditor("seed")).rejects.toThrow(
				/seher is not running in the foreground terminal/,
			);
		},
	);

	// In environments with a controlling terminal, verify that it errors when
	// the editor exits with a non-zero code.
	test.skipIf(!hasControllingTty())(
		"errors when editor exits non-zero",
		async () => {
			const prev = process.env.EDITOR;
			process.env.EDITOR = "/usr/bin/false";
			try {
				await expect(editPromptInEditor("seed")).rejects.toThrow(
					/exited with code/,
				);
			} finally {
				if (prev === undefined) delete process.env.EDITOR;
				else process.env.EDITOR = prev;
			}
		},
	);
});
