import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ReadStream = () => Promise<string>;

export interface ResolvePromptOptions {
	trailing: string[];
	editorFallback?: boolean;
	readStream?: ReadStream;
	isStdinTty?: boolean;
	runEditor?: (initial?: string) => Promise<string>;
}

export async function readPromptFromStdin(): Promise<string | null> {
	if (isStdinTtyDefault()) return null;
	const trimmed = (await Bun.stdin.text()).trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Verifies that the environment can safely launch an editor.
 *
 * On Unix, this checks that `/dev/tty` can be opened with `r+` (launching an
 * editor after losing the controlling terminal would suspend the process via
 * `SIGTTOU`/`SIGTTIN`). On non-Unix, this checks that both stdin/stdout are
 * TTYs.
 *
 * To match the behavior of the Rust version
 * (`seher::prompt::ensure_editor_available`), the error message includes the
 * English string `seher is not running in the foreground terminal` (so it
 * stays greppable in logs).
 */
export function ensureEditorAvailable(): void {
	if (process.platform !== "win32") {
		let fd: number | null = null;
		try {
			fd = openSync("/dev/tty", "r+");
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(
				"seher is not running in the foreground terminal. " +
					"Run `fg` to bring it to the foreground, then try again. " +
					`(cannot open /dev/tty: ${detail})`,
			);
		} finally {
			if (fd !== null) {
				try {
					closeSync(fd);
				} catch {
					// best effort
				}
			}
		}
		return;
	}
	// On non-Unix (Windows), there is no /dev/tty, so fall back to checking
	// whether stdin/stdout are TTYs.
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error(
			"seher is not running in the foreground terminal. " +
				"stdin/stdout is not a terminal; open an interactive terminal to edit.",
		);
	}
}

export async function editPromptInEditor(initial?: string): Promise<string> {
	ensureEditorAvailable();

	const editor = process.env.EDITOR ?? "vim";
	const tmpPath = join(
		tmpdir(),
		`seher-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
	);
	const file = Bun.file(tmpPath);
	await Bun.write(file, initial ?? "");

	// On Unix, re-open `/dev/tty` and pass it as the editor's stdio so the
	// user can still edit on their terminal even if stdin/stdout are
	// redirected.
	let ttyFd: number | null = null;
	try {
		if (process.platform !== "win32") {
			try {
				ttyFd = openSync("/dev/tty", "r+");
			} catch {
				// This normally won't fail if `ensureEditorAvailable()` just
				// succeeded, but fall back to inherit if it does fail.
				ttyFd = null;
			}
		}
		const spawnOpts: Parameters<typeof Bun.spawn>[1] =
			ttyFd !== null
				? { stdin: ttyFd, stdout: ttyFd, stderr: ttyFd }
				: { stdin: "inherit", stdout: "inherit", stderr: "inherit" };
		const proc = Bun.spawn([editor, tmpPath], spawnOpts);
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`Editor '${editor}' exited with code ${code}`);
		}
		const contents = await Bun.file(tmpPath).text();
		return contents.trim();
	} finally {
		if (ttyFd !== null) {
			try {
				closeSync(ttyFd);
			} catch {
				// best effort
			}
		}
		try {
			await Bun.file(tmpPath).delete();
		} catch {
			// best effort cleanup
		}
	}
}

export async function resolvePrompt(
	opts: ResolvePromptOptions,
): Promise<string | null> {
	if (opts.trailing.length > 0) {
		return opts.trailing.join(" ");
	}

	const readStream = opts.readStream ?? defaultReadStream;
	const stdinText = await readStream();
	const trimmed = stdinText.trim();
	if (trimmed.length > 0) return trimmed;

	const editorFallback = opts.editorFallback ?? true;
	if (!editorFallback) return null;

	const isTty = opts.isStdinTty ?? isStdinTtyDefault();
	if (!isTty) return null;

	const runEditor = opts.runEditor ?? editPromptInEditor;
	const edited = await runEditor();
	return edited.length > 0 ? edited : null;
}

async function defaultReadStream(): Promise<string> {
	if (isStdinTtyDefault()) return "";
	return await Bun.stdin.text();
}

function isStdinTtyDefault(): boolean {
	return typeof process !== "undefined" && process.stdin.isTTY === true;
}
