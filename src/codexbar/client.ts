import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import {
	CodexBarError,
	CodexBarNotFoundError,
	CodexBarTimeoutError,
} from "./errors.ts";
import type { CodexBarUsageResponse } from "./types.ts";

export interface RunCodexBarUsageOptions {
	binPath?: string;
	accountLabel?: string;
	accountIndex?: number;
	timeoutMs?: number;
}

const DEFAULT_BIN = "/usr/local/bin/codexbar";
const DEFAULT_TIMEOUT_MS = 15_000;
const TIMEOUT_EXIT_CODE = 4;

function whichSync(name: string): string | null {
	const PATH = process.env.PATH ?? "";
	const exts =
		process.platform === "win32"
			? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
			: [""];
	for (const dir of PATH.split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = join(dir, name + ext);
			try {
				if (statSync(candidate).isFile()) return candidate;
			} catch {
				// not found, try next
			}
		}
	}
	return null;
}

function resolveBinPath(explicit?: string): string {
	if (explicit && explicit.length > 0) {
		return explicit;
	}
	const found = whichSync("codexbar");
	if (found) {
		return found;
	}
	return DEFAULT_BIN;
}

async function readAll(stream: Readable | null | undefined): Promise<string> {
	if (!stream) return "";
	const chunks: Buffer[] = [];
	try {
		for await (const chunk of stream) {
			chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
		}
	} catch {
		// Stream may close prematurely if spawn fails (e.g. ENOENT).
		// The spawn error is captured separately on the child process.
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function runCodexBarUsage(
	provider: string,
	opts: RunCodexBarUsageOptions = {},
): Promise<CodexBarUsageResponse> {
	const bin = resolveBinPath(opts.binPath);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const args: string[] = ["usage", "--format", "json", "--provider", provider];
	if (opts.accountLabel) {
		args.push("--account", opts.accountLabel);
	}
	if (typeof opts.accountIndex === "number") {
		args.push("--account-index", String(opts.accountIndex));
	}

	const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

	const exited = new Promise<{
		code: number;
		spawnError?: NodeJS.ErrnoException;
	}>((resolve) => {
		proc.once("error", (err) => {
			resolve({ code: -1, spawnError: err as NodeJS.ErrnoException });
		});
		proc.once("close", (code) => {
			resolve({ code: code ?? 0 });
		});
	});

	// Race process completion against the timeout. We bail out as soon as the
	// timer fires rather than awaiting stdout/stderr — under sh -> sleep,
	// SIGTERM/SIGKILL on the shell may leave an orphaned child holding the
	// stream file descriptors open, which would hang readAll().
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const completion = Promise.all([
		readAll(proc.stdout),
		readAll(proc.stderr),
		exited,
	]).then(
		([stdout, stderr, ex]) =>
			({
				kind: "exited",
				stdout,
				stderr,
				exitCode: ex.code,
				spawnError: ex.spawnError,
			}) as const,
	);
	const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
		timeoutHandle = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				// best effort
			}
			resolve({ kind: "timeout" });
		}, timeoutMs);
	});
	const result = await Promise.race([completion, timeoutPromise]);
	if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

	if (result.kind === "timeout") {
		// Drain streams so they can be GC'd; ignore failures.
		completion.catch(() => {});
		throw new CodexBarTimeoutError(
			`codexbar usage timed out after ${timeoutMs}ms (provider=${provider})`,
			"",
		);
	}

	const { stdout, stderr, exitCode, spawnError } = result;

	if (spawnError?.code === "ENOENT") {
		throw new CodexBarNotFoundError(
			`codexbar binary not found at ${bin}. Install CodexBar or pass binPath.`,
		);
	}

	if (spawnError) {
		throw new CodexBarError(
			`failed to spawn codexbar: ${spawnError.message}`,
			exitCode,
			stderr,
		);
	}

	if (exitCode === TIMEOUT_EXIT_CODE) {
		throw new CodexBarTimeoutError(
			`codexbar usage timed out after ${timeoutMs}ms (provider=${provider})`,
			stderr,
		);
	}

	if (exitCode !== 0) {
		throw new CodexBarError(
			`codexbar usage exited with code ${exitCode} (provider=${provider}): ${stderr.trim()}`,
			exitCode,
			stderr,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (err) {
		throw new CodexBarError(
			`failed to parse codexbar JSON output: ${(err as Error).message}`,
			exitCode,
			stderr,
		);
	}

	// codexbar emits a JSON array (one entry per provider) even when
	// --provider selects a single one — unwrap to the matching entry.
	if (!Array.isArray(parsed)) {
		throw new CodexBarError(
			`codexbar returned a non-array JSON payload (provider=${provider})`,
			exitCode,
			stderr,
		);
	}
	const entries = parsed as CodexBarUsageResponse[];
	const match = entries.find((e) => e.provider === provider);
	if (!match) {
		throw new CodexBarError(
			`codexbar returned no entry for provider=${provider}`,
			exitCode,
			stderr,
		);
	}
	return match;
}
