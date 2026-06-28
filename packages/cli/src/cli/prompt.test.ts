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
	// 環境依存 (制御端末の有無) のため Ok/Err どちらでも panic しないことだけ確認する。
	test("is callable without crashing (smoke)", () => {
		let threw = false;
		try {
			ensureEditorAvailable();
		} catch (err) {
			threw = true;
			// 失敗時は Rust 版と検索性を揃えるためのメッセージを含むこと。
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain(
				"seher is not running in the foreground terminal",
			);
		}
		// throw したかどうかは環境次第なのでアサートしない。
		expect(typeof threw).toBe("boolean");
	});
});

describe("editPromptInEditor", () => {
	// 制御端末が無い環境 (CI など) では `/dev/tty` を開けないため、エディタ
	// 子プロセスの stdio に渡せず必ず失敗する。Rust 版テストと同じく
	// 「TTY がある時だけ走らせる smoke テスト」とする。
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

	// 制御端末が無い場合は `ensureEditorAvailable()` で即エラーになるはず。
	test.skipIf(hasControllingTty())(
		"throws foreground-terminal error when no controlling tty",
		async () => {
			await expect(editPromptInEditor("seed")).rejects.toThrow(
				/seher is not running in the foreground terminal/,
			);
		},
	);

	// 制御端末がある環境では、エディタが非ゼロ終了した時にエラーになることを確認する。
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
