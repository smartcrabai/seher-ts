import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexBarUsage } from "./client.ts";
import {
	CodexBarError,
	CodexBarNotFoundError,
	CodexBarTimeoutError,
} from "./errors.ts";

let workDir = "";

function writeScript(name: string, body: string): string {
	const path = join(workDir, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return path;
}

beforeAll(() => {
	workDir = mkdtempSync(join(tmpdir(), "codexbar-test-"));
});

afterAll(() => {
	if (workDir) {
		rmSync(workDir, { recursive: true, force: true });
	}
});

describe("runCodexBarUsage", () => {
	test("parses JSON from a successful run", async () => {
		const payload = {
			provider: "codex",
			usage: {
				primary: {
					usedPercent: 42,
					windowMinutes: 60,
					resetsAt: "2026-04-23T12:00:00Z",
				},
			},
		};
		const bin = writeScript(
			"ok.sh",
			`cat <<'JSON'\n${JSON.stringify(payload)}\nJSON`,
		);
		const result = await runCodexBarUsage("codex", { binPath: bin });
		expect(result).toEqual(payload);
	});

	test("passes provider and account options as CLI arguments", async () => {
		const argsFile = join(workDir, "args.txt");
		const bin = writeScript(
			"args.sh",
			`printf '%s\\n' "$@" > "${argsFile}"; printf '{"provider":"codex","usage":{}}'`,
		);
		await runCodexBarUsage("codex", {
			binPath: bin,
			accountLabel: "work",
			accountIndex: 3,
		});
		const captured = await Bun.file(argsFile).text();
		const lines = captured.split("\n").filter((l) => l.length > 0);
		expect(lines).toEqual([
			"usage",
			"--format",
			"json",
			"--provider",
			"codex",
			"--account",
			"work",
			"--account-index",
			"3",
		]);
	});

	test("throws CodexBarTimeoutError when the binary exits with code 4", async () => {
		const bin = writeScript("timeout.sh", "echo 'boom' 1>&2; exit 4");
		await expect(
			runCodexBarUsage("codex", { binPath: bin }),
		).rejects.toBeInstanceOf(CodexBarTimeoutError);
	});

	test("throws CodexBarTimeoutError when the process exceeds timeoutMs", async () => {
		const bin = writeScript("slow.sh", "sleep 5");
		await expect(
			runCodexBarUsage("codex", { binPath: bin, timeoutMs: 50 }),
		).rejects.toBeInstanceOf(CodexBarTimeoutError);
	});

	test("throws CodexBarError for other non-zero exit codes", async () => {
		const bin = writeScript("fail.sh", "echo 'nope' 1>&2; exit 2");
		let caught: unknown;
		try {
			await runCodexBarUsage("codex", { binPath: bin });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(CodexBarError);
		expect(caught).not.toBeInstanceOf(CodexBarTimeoutError);
		if (caught instanceof CodexBarError) {
			expect(caught.exitCode).toBe(2);
			expect(caught.stderr).toContain("nope");
		}
	});

	test("throws CodexBarError when stdout is not valid JSON", async () => {
		const bin = writeScript("garbage.sh", "echo 'not json'");
		await expect(
			runCodexBarUsage("codex", { binPath: bin }),
		).rejects.toBeInstanceOf(CodexBarError);
	});

	test("throws CodexBarNotFoundError when the binary does not exist", async () => {
		const missing = join(workDir, "does-not-exist");
		await expect(
			runCodexBarUsage("codex", { binPath: missing }),
		).rejects.toBeInstanceOf(CodexBarNotFoundError);
	});
});
