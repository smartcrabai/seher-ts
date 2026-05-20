import { describe, expect, test } from "bun:test";
import { ClaudeTerminalSDK } from "./sdk.ts";
import type {
	ClaudeSessionRef,
	ClaudeTerminalResponse,
	ClaudeTranscriptReader,
	FindClaudeSessionOptions,
	TerminalBackend,
	TerminalSession,
	TerminalStartOptions,
	TranscriptMessage,
	WaitForAssistantResponseOptions,
} from "./types.ts";
import { ClaudeTerminalError } from "./types.ts";

interface StartCall {
	options: TerminalStartOptions;
}

interface PasteCall {
	session: TerminalSession;
	text: string;
}

interface RecordingBackend {
	backend: TerminalBackend;
	startCalls: StartCall[];
	pasteCalls: PasteCall[];
	stopCalls: TerminalSession[];
	stopShouldThrow?: boolean;
}

function recordingBackend(
	opts: { sessionId?: string; stopShouldThrow?: boolean } = {},
): RecordingBackend {
	const startCalls: StartCall[] = [];
	const pasteCalls: PasteCall[] = [];
	const stopCalls: TerminalSession[] = [];
	const backend: TerminalBackend = {
		start: async (options) => {
			startCalls.push({ options });
			return { id: opts.sessionId ?? "test-session" };
		},
		pasteText: async (session, text) => {
			pasteCalls.push({ session, text });
		},
		captureScreen: async () => "",
		stop: async (session) => {
			stopCalls.push(session);
			if (opts.stopShouldThrow) {
				throw new Error("stop failed");
			}
		},
	};
	return { backend, startCalls, pasteCalls, stopCalls };
}

interface RecordingReader {
	reader: ClaudeTranscriptReader;
	findCalls: FindClaudeSessionOptions[];
	waitCalls: Array<{
		session: ClaudeSessionRef;
		options: WaitForAssistantResponseOptions;
	}>;
}

function recordingReader(response: ClaudeTerminalResponse): RecordingReader {
	const findCalls: FindClaudeSessionOptions[] = [];
	const waitCalls: RecordingReader["waitCalls"] = [];
	const reader: ClaudeTranscriptReader = {
		findSession: async (options) => {
			findCalls.push(options);
			return {
				sessionId: response.sessionId,
				transcriptPath: `/fake/${response.sessionId}.jsonl`,
			};
		},
		waitForAssistantResponse: async (session, options) => {
			waitCalls.push({ session, options });
			return response;
		},
	};
	return { reader, findCalls, waitCalls };
}

function asMsg(m: TranscriptMessage): TranscriptMessage {
	return m;
}

describe("ClaudeTerminalSDK.run", () => {
	test("starts backend with command + cwd, then pastes prompt, then waits and stops session", async () => {
		const rb = recordingBackend({ sessionId: "tmux-1" });
		const response: ClaudeTerminalResponse = {
			sessionId: "claude-1",
			assistantMessages: [],
			lastResultMessage: asMsg({
				type: "result",
				subtype: "success",
				result: "all done",
			}),
		};
		const rr = recordingReader(response);
		const sdk = new ClaudeTerminalSDK({
			cwd: "/repo",
			claudeBin: "/bin/claude",
			transcriptRoot: "/trans",
			backendImpl: rb.backend,
			transcriptReader: rr.reader,
		});
		const result = await sdk.run({ prompt: "hello", model: "claude-opus" });
		expect(result.kind).toBe("claude-terminal");
		expect(result.text).toBe("all done");
		expect(rb.startCalls).toHaveLength(1);
		const start = rb.startCalls[0];
		expect(start).toBeDefined();
		if (!start) return;
		expect(start.options.cwd).toBe("/repo");
		expect(start.options.command).toEqual([
			"/bin/claude",
			"--model",
			"claude-opus",
		]);
		expect(rr.findCalls).toHaveLength(1);
		expect(rr.findCalls[0]?.root).toBe("/trans");
		expect(rb.pasteCalls).toHaveLength(1);
		expect(rb.pasteCalls[0]?.text).toBe("hello");
		expect(rb.stopCalls).toHaveLength(1);
	});

	test("pastes the prompt before polling for a transcript session", async () => {
		const events: string[] = [];
		const backend: TerminalBackend = {
			start: async () => {
				events.push("start");
				return { id: "tmux-1" };
			},
			pasteText: async () => {
				events.push("paste");
			},
			captureScreen: async () => "",
			stop: async () => {
				events.push("stop");
			},
		};
		const reader: ClaudeTranscriptReader = {
			findSession: async () => {
				events.push("findSession");
				return { sessionId: "s", transcriptPath: "/fake/s.jsonl" };
			},
			waitForAssistantResponse: async () => {
				events.push("wait");
				return {
					sessionId: "s",
					assistantMessages: [],
					lastResultMessage: asMsg({
						type: "result",
						subtype: "success",
						result: "ok",
					}),
				};
			},
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: reader,
		});
		await sdk.run({ prompt: "hi" });
		expect(events).toEqual(["start", "paste", "findSession", "wait", "stop"]);
	});

	test("does not stop the session when keepSession is true", async () => {
		const rb = recordingBackend();
		const rr = recordingReader({
			sessionId: "x",
			assistantMessages: [],
			lastResultMessage: asMsg({
				type: "result",
				subtype: "success",
				result: "ok",
			}),
		});
		const sdk = new ClaudeTerminalSDK({
			backendImpl: rb.backend,
			transcriptReader: rr.reader,
			keepSession: true,
		});
		await sdk.run({ prompt: "hi" });
		expect(rb.stopCalls).toHaveLength(0);
	});

	test("stops the session even when waitForAssistantResponse rejects", async () => {
		const rb = recordingBackend();
		const reader: ClaudeTranscriptReader = {
			findSession: async () => ({
				sessionId: "x",
				transcriptPath: "/fake/x.jsonl",
			}),
			waitForAssistantResponse: async () => {
				throw new Error("transcript timeout");
			},
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: rb.backend,
			transcriptReader: reader,
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toThrow(
			"transcript timeout",
		);
		expect(rb.stopCalls).toHaveLength(1);
	});

	test("swallows errors from backend.stop during cleanup", async () => {
		const rb = recordingBackend({ stopShouldThrow: true });
		const rr = recordingReader({
			sessionId: "x",
			assistantMessages: [],
			lastResultMessage: asMsg({
				type: "result",
				subtype: "success",
				result: "ok",
			}),
		});
		const sdk = new ClaudeTerminalSDK({
			backendImpl: rb.backend,
			transcriptReader: rr.reader,
		});
		const r = await sdk.run({ prompt: "hi" });
		expect(r.text).toBe("ok");
	});

	test("rejects unsupported backend at construction", () => {
		expect(
			() =>
				new ClaudeTerminalSDK({
					backend: "screen" as "tmux",
				}),
		).toThrow(ClaudeTerminalError);
	});

	test("forwards systemPrompt and dangerouslySkipPermissions into the claude command", async () => {
		const rb = recordingBackend();
		const rr = recordingReader({
			sessionId: "x",
			assistantMessages: [],
			lastResultMessage: asMsg({
				type: "result",
				subtype: "success",
				result: "ok",
			}),
		});
		const sdk = new ClaudeTerminalSDK({
			backendImpl: rb.backend,
			transcriptReader: rr.reader,
			dangerouslySkipPermissions: true,
		});
		await sdk.run({ prompt: "hi", systemPrompt: "be terse" });
		expect(rb.startCalls[0]?.options.command).toEqual([
			"claude",
			"--append-system-prompt",
			"be terse",
			"--dangerously-skip-permissions",
		]);
	});
});

describe("ClaudeTerminalSDK.stream", () => {
	test("yields a single chunk with the full text", async () => {
		const rb = recordingBackend();
		const rr = recordingReader({
			sessionId: "x",
			assistantMessages: [],
			lastResultMessage: asMsg({
				type: "result",
				subtype: "success",
				result: "hello there",
			}),
		});
		const sdk = new ClaudeTerminalSDK({
			backendImpl: rb.backend,
			transcriptReader: rr.reader,
		});
		const chunks: string[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			chunks.push(chunk.delta);
		}
		expect(chunks).toEqual(["hello there"]);
	});

	test("yields nothing when text is empty", async () => {
		const rb = recordingBackend();
		const rr = recordingReader({
			sessionId: "x",
			assistantMessages: [],
		});
		const sdk = new ClaudeTerminalSDK({
			backendImpl: rb.backend,
			transcriptReader: rr.reader,
		});
		const chunks: unknown[] = [];
		for await (const chunk of sdk.stream({ prompt: "hi" })) {
			chunks.push(chunk);
		}
		expect(chunks).toEqual([]);
	});
});
