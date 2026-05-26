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
	submitCalls: TerminalSession[];
	stopCalls: TerminalSession[];
	stopShouldThrow?: boolean;
}

function recordingBackend(
	opts: { sessionId?: string; stopShouldThrow?: boolean } = {},
): RecordingBackend {
	const startCalls: StartCall[] = [];
	const pasteCalls: PasteCall[] = [];
	const submitCalls: TerminalSession[] = [];
	const stopCalls: TerminalSession[] = [];
	let lastPaste = "";
	const backend: TerminalBackend = {
		start: async (options) => {
			startCalls.push({ options });
			return { id: opts.sessionId ?? "test-session" };
		},
		pasteText: async (session, text) => {
			pasteCalls.push({ session, text });
			lastPaste = text;
		},
		submit: async (session) => {
			submitCalls.push(session);
		},
		// Capture the prompt arrow so waitForReady succeeds, plus the pasted
		// text so waitForPasteVisible succeeds. Tests that need different
		// captureScreen behavior provide their own backend.
		captureScreen: async () => `❯ ${lastPaste}`,
		stop: async (session) => {
			stopCalls.push(session);
			if (opts.stopShouldThrow) {
				throw new Error("stop failed");
			}
		},
	};
	return { backend, startCalls, pasteCalls, submitCalls, stopCalls };
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
		listSessionNames: async () => new Set<string>(),
	};
	return { reader, findCalls, waitCalls };
}

function asMsg(m: TranscriptMessage): TranscriptMessage {
	return m;
}

function neverRendersBackend(): {
	backend: TerminalBackend;
	now: () => Date;
} {
	let currentTime = 1_000_000;
	const backend: TerminalBackend = {
		start: async () => ({ id: "tmux-1" }),
		pasteText: async () => {},
		submit: async () => {},
		captureScreen: async () => {
			currentTime += 10;
			return "";
		},
		stop: async () => {},
	};
	return { backend, now: () => new Date(currentTime) };
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
			"--permission-mode",
			"bypassPermissions",
		]);
		expect(rr.findCalls).toHaveLength(1);
		expect(rr.findCalls[0]?.root).toBe("/trans");
		expect(rb.pasteCalls).toHaveLength(1);
		expect(rb.pasteCalls[0]?.text).toBe("hello");
		expect(rb.stopCalls).toHaveLength(1);
	});

	test("pastes the prompt, waits for it to render, submits, then polls for a transcript session", async () => {
		const events: string[] = [];
		let pasted = "";
		const backend: TerminalBackend = {
			start: async () => {
				events.push("start");
				return { id: "tmux-1" };
			},
			pasteText: async (_session, text) => {
				events.push("paste");
				pasted = text;
			},
			submit: async () => {
				events.push("submit");
			},
			captureScreen: async () => `❯ ${pasted}`,
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
			listSessionNames: async () => new Set(),
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: reader,
		});
		await sdk.run({ prompt: "hi" });
		expect(events).toEqual([
			"start",
			"paste",
			"submit",
			"findSession",
			"wait",
			"stop",
		]);
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
			listSessionNames: async () => new Set(),
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

	test("waits for the TUI prompt to render before pasting", async () => {
		const events: string[] = [];
		let captureCount = 0;
		let pasted = "";
		const backend: TerminalBackend = {
			start: async () => {
				events.push("start");
				return { id: "tmux-1" };
			},
			pasteText: async (_session, text) => {
				events.push("paste");
				pasted = text;
			},
			submit: async () => {
				events.push("submit");
			},
			captureScreen: async () => {
				captureCount += 1;
				events.push(`capture#${captureCount}`);
				// Simulate the TUI taking a couple of polls to render. After
				// paste happens, include the pasted text so waitForPasteVisible
				// completes.
				if (captureCount < 3) return "";
				return pasted.length > 0 ? `❯ ${pasted}` : "❯ ";
			},
			stop: async () => {
				events.push("stop");
			},
		};
		const reader: ClaudeTranscriptReader = {
			findSession: async () => ({
				sessionId: "s",
				transcriptPath: "/fake/s.jsonl",
			}),
			waitForAssistantResponse: async () => ({
				sessionId: "s",
				assistantMessages: [],
				lastResultMessage: asMsg({
					type: "result",
					subtype: "success",
					result: "ok",
				}),
			}),
			listSessionNames: async () => new Set(),
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: reader,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
		});
		await sdk.run({ prompt: "hi" });
		expect(events.indexOf("paste")).toBeGreaterThan(
			events.indexOf("capture#3"),
		);
		// 3 captures to detect the prompt arrow + 1 more to confirm the paste echoed.
		expect(captureCount).toBe(4);
		expect(events.indexOf("submit")).toBeGreaterThan(events.indexOf("paste"));
	});

	test("treats a [Pasted text #N +M lines] citation as paste completion when the needle is collapsed", async () => {
		const events: string[] = [];
		const backend: TerminalBackend = {
			start: async () => {
				events.push("start");
				return { id: "tmux-1" };
			},
			pasteText: async () => {
				events.push("paste");
			},
			submit: async () => {
				events.push("submit");
			},
			// The needle (last 24 chars of the prompt) is NOT in the screen -
			// only the prompt prefix and Claude's collapsed-paste citation.
			captureScreen: async () =>
				"❯ Analyze the task content [Pasted text #1 +9 lines]",
			stop: async () => {
				events.push("stop");
			},
		};
		const reader: ClaudeTranscriptReader = {
			findSession: async () => ({
				sessionId: "s",
				transcriptPath: "/fake/s.jsonl",
			}),
			waitForAssistantResponse: async () => ({
				sessionId: "s",
				assistantMessages: [],
				lastResultMessage: asMsg({
					type: "result",
					subtype: "success",
					result: "ok",
				}),
			}),
			listSessionNames: async () => new Set(),
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: reader,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
		});
		const longPrompt = `Analyze the task content. ${"x".repeat(200)} (if applicable).`;
		await sdk.run({ prompt: longPrompt });
		expect(events).toEqual(["start", "paste", "submit", "stop"]);
	});

	test("throws ClaudeTerminalTimeoutError when the TUI never renders", async () => {
		const backend: TerminalBackend = {
			start: async () => ({ id: "tmux-1" }),
			pasteText: async () => {},
			submit: async () => {},
			captureScreen: async () => "",
			stop: async () => {},
		};
		const reader: ClaudeTranscriptReader = {
			findSession: async () => ({
				sessionId: "s",
				transcriptPath: "/fake/s.jsonl",
			}),
			waitForAssistantResponse: async () => ({
				sessionId: "s",
				assistantMessages: [],
			}),
			listSessionNames: async () => new Set(),
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: reader,
			readyTimeoutMs: 5,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toThrow(
			/timed out waiting for Claude TUI/,
		);
	});

	test("opts.timeoutMs lifts the default readyTimeoutMs when no instance override is set", async () => {
		const { backend, now } = neverRendersBackend();
		const rr = recordingReader({ sessionId: "s", assistantMessages: [] });
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: rr.reader,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
			now,
		});
		await expect(sdk.run({ prompt: "hi", timeoutMs: 50 })).rejects.toThrow(
			/within 50ms/,
		);
	});

	test("instance readyTimeoutMs takes precedence over opts.timeoutMs", async () => {
		const { backend, now } = neverRendersBackend();
		const rr = recordingReader({ sessionId: "s", assistantMessages: [] });
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: rr.reader,
			readyTimeoutMs: 25,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
			now,
		});
		await expect(sdk.run({ prompt: "hi", timeoutMs: 60_000 })).rejects.toThrow(
			/within 25ms/,
		);
	});

	test("fails fast when captureScreen errors repeatedly", async () => {
		const backend: TerminalBackend = {
			start: async () => ({ id: "tmux-1" }),
			pasteText: async () => {},
			submit: async () => {},
			captureScreen: async () => {
				throw new Error("session not found");
			},
			stop: async () => {},
		};
		const reader: ClaudeTranscriptReader = {
			findSession: async () => ({
				sessionId: "s",
				transcriptPath: "/fake/s.jsonl",
			}),
			waitForAssistantResponse: async () => ({
				sessionId: "s",
				assistantMessages: [],
			}),
			listSessionNames: async () => new Set(),
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: reader,
			readyTimeoutMs: 60_000,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
		});
		await expect(sdk.run({ prompt: "hi" })).rejects.toThrow(
			/captureScreen failed 3 times/,
		);
	});

	test("fails fast with cause when captureScreen errors repeatedly during paste-visible wait", async () => {
		// Same fail-fast contract as waitForReady — after 3 consecutive
		// captureScreen rejections, throw with the underlying error attached as
		// `cause` instead of silently waiting out the full pasteVisibleTimeoutMs.
		let pasteHappened = false;
		const backend: TerminalBackend = {
			start: async () => ({ id: "tmux-1" }),
			pasteText: async () => {
				pasteHappened = true;
			},
			submit: async () => {},
			captureScreen: async () => {
				if (!pasteHappened) return "❯ ";
				throw new Error("tmux died during paste");
			},
			stop: async () => {},
		};
		const reader: ClaudeTranscriptReader = {
			findSession: async () => ({
				sessionId: "s",
				transcriptPath: "/fake/s.jsonl",
			}),
			waitForAssistantResponse: async () => ({
				sessionId: "s",
				assistantMessages: [],
			}),
			listSessionNames: async () => new Set(),
		};
		const sdk = new ClaudeTerminalSDK({
			backendImpl: backend,
			transcriptReader: reader,
			pasteVisibleTimeoutMs: 60_000,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
		});
		const err = (await sdk.run({ prompt: "hi" }).catch((e) => e)) as Error & {
			cause?: unknown;
		};
		expect(err.message).toMatch(/captureScreen failed 3 times/);
		expect((err.cause as Error | undefined)?.message).toBe(
			"tmux died during paste",
		);
	});

	test("empty prompt skips waitForPasteVisible polling entirely (short-circuit, not includes(''))", async () => {
		// Tests the empty-needle short-circuit in pasteIsConsumed: we must NOT
		// even call captureScreen during waitForPasteVisible for an empty
		// prompt. Counting captureScreen calls is the only way to distinguish
		// the short-circuit from a naive `screen.includes("")` fallback —
		// JS `"".includes("") === true`, so a regression that removes the
		// short-circuit and relies on includes("") would still return true
		// from pasteIsConsumed and pass the smoke-only version of this test.
		let captureCount = 0;
		let pasteHappened = false;
		const backend: TerminalBackend = {
			start: async () => ({ id: "tmux-1" }),
			pasteText: async () => {
				pasteHappened = true;
			},
			submit: async () => {},
			captureScreen: async () => {
				captureCount += 1;
				// First few calls (waitForReady) return the prompt arrow. Any
				// call after pasteText means waitForPasteVisible did NOT
				// short-circuit and started polling — fail the test loudly.
				if (pasteHappened) {
					throw new Error(
						"captureScreen called after pasteText — short-circuit broken",
					);
				}
				return "❯ ";
			},
			stop: async () => {},
		};
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
			backendImpl: backend,
			transcriptReader: rr.reader,
			pasteVisibleTimeoutMs: 50,
			readyPollIntervalMs: 1,
			sleep: () => Promise.resolve(),
		});
		const result = await sdk.run({ prompt: "" });
		expect(result.text).toBe("ok");
		// Exactly the one captureScreen call from waitForReady. If
		// pasteIsConsumed regressed to `screen.includes("")` semantics, the
		// loop would issue at least one more captureScreen and throw above.
		expect(captureCount).toBe(1);
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

	test("defaults to --permission-mode bypassPermissions when permissionMode is unset", async () => {
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
		});
		await sdk.run({ prompt: "hi", systemPrompt: "be terse" });
		expect(rb.startCalls[0]?.options.command).toEqual([
			"claude",
			"--append-system-prompt",
			"be terse",
			"--permission-mode",
			"bypassPermissions",
		]);
	});

	test("forwards explicit permissionMode into the claude command", async () => {
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
			permissionMode: "default",
		});
		await sdk.run({ prompt: "hi" });
		expect(rb.startCalls[0]?.options.command).toEqual([
			"claude",
			"--permission-mode",
			"default",
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
