import { describe, expect, test } from "bun:test";
import {
	encodeProjectDir,
	FileSystemTranscriptReader,
	type FsAdapter,
	parseJsonl,
} from "./transcript-reader.ts";
import { ClaudeTerminalTimeoutError, type TranscriptMessage } from "./types.ts";

interface FakeFile {
	mtimeMs: number;
	content: string;
}

function makeFs(
	tree: Record<string, FakeFile> = {},
	dirs: Record<string, string[]> = {},
): FsAdapter {
	return {
		readdir: async (path) => {
			const entries = dirs[path];
			if (entries === undefined) throw new Error(`ENOENT ${path}`);
			return entries;
		},
		stat: async (path) => {
			const f = tree[path];
			if (f === undefined) throw new Error(`ENOENT ${path}`);
			return { mtimeMs: f.mtimeMs };
		},
		readFile: async (path) => {
			const f = tree[path];
			if (f === undefined) throw new Error(`ENOENT ${path}`);
			return f.content;
		},
	};
}

describe("encodeProjectDir", () => {
	test("encodes a unix path", () => {
		expect(encodeProjectDir("/Users/foo/repo")).toBe("-Users-foo-repo");
	});

	test("resolves relative paths against cwd", () => {
		const r = encodeProjectDir(".");
		expect(r.startsWith("-")).toBe(true);
	});
});

describe("parseJsonl", () => {
	test("parses one message per line, skipping invalid lines", () => {
		const raw =
			'{"type":"user","message":{"content":"hi"}}\n' +
			"not-json\n" +
			'{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}';
		const messages = parseJsonl(raw);
		expect(messages).toHaveLength(2);
		expect(messages[0]?.type).toBe("user");
		expect(messages[1]?.type).toBe("assistant");
	});

	test("returns [] for empty input", () => {
		expect(parseJsonl("")).toEqual([]);
	});

	test("ignores unknown types", () => {
		const raw = '{"type":"foobar","x":1}\n{"type":"result","result":"ok"}';
		const messages = parseJsonl(raw);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.type).toBe("result");
	});
});

describe("FileSystemTranscriptReader.findSession", () => {
	test("returns the earliest .jsonl whose mtime is after `after`", async () => {
		const dir = "/transcripts/-repo";
		const fs = makeFs(
			{
				[`${dir}/old.jsonl`]: { mtimeMs: 100, content: "" },
				[`${dir}/new1.jsonl`]: { mtimeMs: 300, content: "" },
				[`${dir}/new2.jsonl`]: { mtimeMs: 400, content: "" },
			},
			{ [dir]: ["old.jsonl", "new1.jsonl", "new2.jsonl"] },
		);
		const reader = new FileSystemTranscriptReader({ fs, now: () => 1000 });
		const ref = await reader.findSession({
			cwd: "/repo",
			after: new Date(200),
			timeoutMs: 0,
			pollIntervalMs: 10,
			root: "/transcripts",
		});
		expect(ref.transcriptPath).toBe(`${dir}/new1.jsonl`);
		expect(ref.sessionId).toBe("new1");
	});

	test("polls until a matching file appears and respects timeout", async () => {
		const _dir = "/transcripts/-repo";
		let visible = false;
		const fs: FsAdapter = {
			readdir: async () => (visible ? ["s.jsonl"] : []),
			stat: async () => ({ mtimeMs: 500 }),
			readFile: async () => "",
		};
		let nowMs = 0;
		const reader = new FileSystemTranscriptReader({
			fs,
			now: () => nowMs,
			sleep: async (ms) => {
				nowMs += ms;
				if (nowMs >= 30) visible = true;
			},
		});
		const ref = await reader.findSession({
			cwd: "/repo",
			after: new Date(100),
			timeoutMs: 200,
			pollIntervalMs: 10,
			root: "/transcripts",
		});
		expect(ref.sessionId).toBe("s");
	});

	test("skips files in excludeNames even when their mtime is newer than `after`", async () => {
		const dir = "/transcripts/-repo";
		const fs = makeFs(
			{
				[`${dir}/existing.jsonl`]: { mtimeMs: 500, content: "" },
				[`${dir}/new.jsonl`]: { mtimeMs: 600, content: "" },
			},
			{ [dir]: ["existing.jsonl", "new.jsonl"] },
		);
		const reader = new FileSystemTranscriptReader({ fs, now: () => 1000 });
		const ref = await reader.findSession({
			cwd: "/repo",
			after: new Date(100),
			timeoutMs: 0,
			pollIntervalMs: 10,
			root: "/transcripts",
			excludeNames: new Set(["existing.jsonl"]),
		});
		expect(ref.sessionId).toBe("new");
	});

	test("throws ClaudeTerminalTimeoutError when no file appears in time", async () => {
		const fs: FsAdapter = {
			readdir: async () => [],
			stat: async () => ({ mtimeMs: 0 }),
			readFile: async () => "",
		};
		let nowMs = 0;
		const reader = new FileSystemTranscriptReader({
			fs,
			now: () => nowMs,
			sleep: async (ms) => {
				nowMs += ms;
			},
		});
		await expect(
			reader.findSession({
				cwd: "/repo",
				after: new Date(0),
				timeoutMs: 50,
				pollIntervalMs: 10,
				root: "/transcripts",
			}),
		).rejects.toBeInstanceOf(ClaudeTerminalTimeoutError);
	});
});

describe("FileSystemTranscriptReader.listSessionNames", () => {
	test("returns the set of .jsonl basenames in the project directory", async () => {
		const dir = "/transcripts/-repo";
		const fs = makeFs({}, { [dir]: ["a.jsonl", "b.jsonl", "ignore.txt"] });
		const reader = new FileSystemTranscriptReader({ fs });
		const names = await reader.listSessionNames({
			root: "/transcripts",
			cwd: "/repo",
		});
		expect(names).toEqual(new Set(["a.jsonl", "b.jsonl"]));
	});

	test("returns an empty set when the project directory does not exist", async () => {
		const fs: FsAdapter = {
			readdir: async () => {
				throw new Error("ENOENT");
			},
			stat: async () => ({ mtimeMs: 0 }),
			readFile: async () => "",
		};
		const reader = new FileSystemTranscriptReader({ fs });
		const names = await reader.listSessionNames({
			root: "/transcripts",
			cwd: "/repo",
		});
		expect(names.size).toBe(0);
	});
});

describe("FileSystemTranscriptReader.waitForAssistantResponse", () => {
	const transcriptPath = "/transcripts/-repo/s.jsonl";

	function asMsg(m: TranscriptMessage): TranscriptMessage {
		return m;
	}

	test("returns when a `result` message appears", async () => {
		const body = [
			asMsg({ type: "user", message: { content: "hi" } }),
			asMsg({
				type: "assistant",
				message: { content: [{ type: "text", text: "hello" }] },
			}),
			asMsg({ type: "result", subtype: "success", result: "hello" }),
		]
			.map((m) => JSON.stringify(m))
			.join("\n");
		const fs = makeFs({ [transcriptPath]: { mtimeMs: 0, content: body } });
		const reader = new FileSystemTranscriptReader({ fs, now: () => 0 });
		const r = await reader.waitForAssistantResponse(
			{ sessionId: "s", transcriptPath },
			{ timeoutMs: 0, pollIntervalMs: 10 },
		);
		expect(r.sessionId).toBe("s");
		expect(r.assistantMessages).toHaveLength(1);
		expect(r.lastResultMessage?.type).toBe("result");
	});

	test("returns assistantMessages as soon as system/turn_duration appears (interactive TUI completion)", async () => {
		const body = [
			asMsg({ type: "user", message: { content: "hi" } }),
			asMsg({
				type: "assistant",
				message: { content: [{ type: "text", text: "hello" }] },
			}),
			asMsg({ type: "system", subtype: "turn_duration" }),
		]
			.map((m) => JSON.stringify(m))
			.join("\n");
		const fs = makeFs({ [transcriptPath]: { mtimeMs: 0, content: body } });
		const reader = new FileSystemTranscriptReader({ fs, now: () => 0 });
		const r = await reader.waitForAssistantResponse(
			{ sessionId: "s", transcriptPath },
			{ timeoutMs: 0, pollIntervalMs: 10 },
		);
		expect(r.sessionId).toBe("s");
		expect(r.assistantMessages).toHaveLength(1);
		// Interactive TUI completion does not populate lastResultMessage.
		expect(r.lastResultMessage).toBeUndefined();
	});

	test("does not return on system/turn_duration alone without any assistant message", async () => {
		let content = JSON.stringify(
			asMsg({ type: "system", subtype: "turn_duration" }),
		);
		const fs: FsAdapter = {
			readdir: async () => [],
			stat: async () => ({ mtimeMs: 0 }),
			readFile: async () => content,
		};
		let nowMs = 0;
		const reader = new FileSystemTranscriptReader({
			fs,
			now: () => nowMs,
			sleep: async (ms) => {
				nowMs += ms;
				if (nowMs >= 20) {
					content = [
						JSON.stringify(
							asMsg({
								type: "assistant",
								message: { content: [{ type: "text", text: "ok" }] },
							}),
						),
						JSON.stringify(asMsg({ type: "system", subtype: "turn_duration" })),
					].join("\n");
				}
			},
		});
		const r = await reader.waitForAssistantResponse(
			{ sessionId: "s", transcriptPath },
			{ timeoutMs: 100, pollIntervalMs: 5 },
		);
		expect(r.assistantMessages).toHaveLength(1);
	});

	test("returns assistantMessages when timeout hits without result", async () => {
		const body = JSON.stringify(
			asMsg({
				type: "assistant",
				message: { content: [{ type: "text", text: "partial" }] },
			}),
		);
		const fs = makeFs({ [transcriptPath]: { mtimeMs: 0, content: body } });
		let nowMs = 0;
		const reader = new FileSystemTranscriptReader({
			fs,
			now: () => nowMs,
			sleep: async (ms) => {
				nowMs += ms;
			},
		});
		const r = await reader.waitForAssistantResponse(
			{ sessionId: "s", transcriptPath },
			{ timeoutMs: 30, pollIntervalMs: 10 },
		);
		expect(r.assistantMessages).toHaveLength(1);
		expect(r.lastResultMessage).toBeUndefined();
	});

	test("throws when neither result nor assistant message ever appears", async () => {
		const fs = makeFs({ [transcriptPath]: { mtimeMs: 0, content: "" } });
		let nowMs = 0;
		const reader = new FileSystemTranscriptReader({
			fs,
			now: () => nowMs,
			sleep: async (ms) => {
				nowMs += ms;
			},
		});
		await expect(
			reader.waitForAssistantResponse(
				{ sessionId: "s", transcriptPath },
				{ timeoutMs: 50, pollIntervalMs: 10 },
			),
		).rejects.toBeInstanceOf(ClaudeTerminalTimeoutError);
	});
});
