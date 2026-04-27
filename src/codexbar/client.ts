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

function resolveBinPath(explicit?: string): string {
	if (explicit && explicit.length > 0) {
		return explicit;
	}
	const found = Bun.which("codexbar");
	if (found) {
		return found;
	}
	return DEFAULT_BIN;
}

async function readAll(
	stream: ReadableStream<Uint8Array> | null | undefined,
): Promise<string> {
	if (!stream) {
		return "";
	}
	return await new Response(stream).text();
}

export async function runCodexBarUsage(
	provider: string,
	opts: RunCodexBarUsageOptions = {},
): Promise<CodexBarUsageResponse> {
	const bin = resolveBinPath(opts.binPath);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const args: string[] = [
		bin,
		"usage",
		"--format",
		"json",
		"--provider",
		provider,
	];
	if (opts.accountLabel) {
		args.push("--account", opts.accountLabel);
	}
	if (typeof opts.accountIndex === "number") {
		args.push("--account-index", String(opts.accountIndex));
	}

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") {
			throw new CodexBarNotFoundError(
				`codexbar binary not found at ${bin}. Install CodexBar or pass binPath.`,
			);
		}
		throw err;
	}

	let timedOut = false;
	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill("SIGTERM");
		} catch {
			// best effort
		}
	}, timeoutMs);

	const [stdout, stderr, exitCode] = await Promise.all([
		readAll(proc.stdout as ReadableStream<Uint8Array> | null),
		readAll(proc.stderr as ReadableStream<Uint8Array> | null),
		proc.exited,
	]);
	clearTimeout(timeoutHandle);

	if (timedOut || exitCode === TIMEOUT_EXIT_CODE) {
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
