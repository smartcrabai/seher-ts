import { describe, expect, test } from "bun:test";
import type { SpawnImpl, SpawnResult } from "./tmux-backend.ts";
import { TmuxBackend } from "./tmux-backend.ts";
import { ClaudeTerminalError } from "./types.ts";

interface Invocation {
	bin: string;
	args: string[];
	env?: Record<string, string>;
}

function recordingSpawn(results: SpawnResult[]): {
	spawn: SpawnImpl;
	calls: Invocation[];
} {
	const calls: Invocation[] = [];
	let i = 0;
	const spawn: SpawnImpl = async (bin, args, options) => {
		calls.push({
			bin,
			args,
			...(options.env !== undefined && { env: options.env }),
		});
		const r = results[i] ?? { exitCode: 0, stdout: "", stderr: "" };
		i += 1;
		return r;
	};
	return { spawn, calls };
}

const ok: SpawnResult = { exitCode: 0, stdout: "", stderr: "" };

describe("TmuxBackend.start", () => {
	test("issues tmux new-session with -d, session name, cwd, and command", async () => {
		const { spawn, calls } = recordingSpawn([ok]);
		const backend = new TmuxBackend({
			tmuxBin: "/usr/bin/tmux",
			sessionPrefix: "seher",
			spawnImpl: spawn,
		});
		const session = await backend.start({
			cwd: "/repo",
			command: ["claude", "--model", "claude-opus-4-7"],
		});
		expect(calls).toHaveLength(1);
		const c = calls[0];
		expect(c).toBeDefined();
		if (!c) return;
		expect(c.bin).toBe("/usr/bin/tmux");
		expect(c.args.slice(0, 6)).toEqual([
			"new-session",
			"-d",
			"-s",
			session.id,
			"-c",
			"/repo",
		]);
		expect(c.args.slice(6)).toEqual(["claude", "--model", "claude-opus-4-7"]);
		expect(session.id.startsWith("seher-")).toBe(true);
	});

	test("throws ClaudeTerminalError when tmux exits non-zero", async () => {
		const { spawn } = recordingSpawn([
			{ exitCode: 1, stdout: "", stderr: "no server" },
		]);
		const backend = new TmuxBackend({ spawnImpl: spawn });
		await expect(
			backend.start({ cwd: "/tmp", command: ["claude"] }),
		).rejects.toBeInstanceOf(ClaudeTerminalError);
	});

	test("forwards env when provided", async () => {
		const { spawn, calls } = recordingSpawn([ok]);
		const backend = new TmuxBackend({ spawnImpl: spawn });
		await backend.start({
			cwd: "/repo",
			command: ["claude"],
			env: { FOO: "bar" },
		});
		expect(calls[0]?.env).toEqual({ FOO: "bar" });
	});
});

describe("TmuxBackend.pasteText", () => {
	test("sends literal text then a separate Enter keystroke", async () => {
		const { spawn, calls } = recordingSpawn([ok, ok]);
		const backend = new TmuxBackend({ spawnImpl: spawn });
		await backend.pasteText({ id: "sid" }, "hello world");
		expect(calls).toHaveLength(2);
		expect(calls[0]?.args).toEqual([
			"send-keys",
			"-t",
			"sid",
			"-l",
			"hello world",
		]);
		expect(calls[1]?.args).toEqual(["send-keys", "-t", "sid", "Enter"]);
	});

	test("throws when send-keys fails", async () => {
		const { spawn } = recordingSpawn([
			{ exitCode: 2, stdout: "", stderr: "no such session" },
		]);
		const backend = new TmuxBackend({ spawnImpl: spawn });
		await expect(backend.pasteText({ id: "sid" }, "hi")).rejects.toBeInstanceOf(
			ClaudeTerminalError,
		);
	});
});

describe("TmuxBackend.captureScreen", () => {
	test("returns stdout from capture-pane -p", async () => {
		const { spawn, calls } = recordingSpawn([
			{ exitCode: 0, stdout: "screen contents\n", stderr: "" },
		]);
		const backend = new TmuxBackend({ spawnImpl: spawn });
		const out = await backend.captureScreen({ id: "sid" });
		expect(out).toBe("screen contents\n");
		expect(calls[0]?.args).toEqual(["capture-pane", "-p", "-t", "sid"]);
	});
});

describe("TmuxBackend.stop", () => {
	test("runs tmux kill-session -t <id>", async () => {
		const { spawn, calls } = recordingSpawn([ok]);
		const backend = new TmuxBackend({ spawnImpl: spawn });
		await backend.stop({ id: "sid" });
		expect(calls[0]?.args).toEqual(["kill-session", "-t", "sid"]);
	});
});
