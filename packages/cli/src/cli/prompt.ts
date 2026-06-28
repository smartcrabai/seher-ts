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
 * エディタを安全に起動できる環境かどうかを確認する。
 *
 * Unix では `/dev/tty` を `r+` で開けることを確認する (制御端末が
 * 失われた状態でエディタを起動すると `SIGTTOU`/`SIGTTIN` で
 * プロセスがサスペンドされてしまうため)。非 Unix では stdin/stdout
 * がいずれも TTY であることを確認する。
 *
 * Rust 版 (`seher::prompt::ensure_editor_available`) と挙動を揃えるため、
 * エラーメッセージには英語の `seher is not running in the foreground terminal`
 * を含める (ログから検索可能にするため)。
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
	// 非 Unix (Windows) では /dev/tty が無いので stdin/stdout の TTY 判定で代用する。
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

	// Unix では stdin/stdout がリダイレクトされていてもユーザの端末で
	// 編集できるよう、`/dev/tty` を改めて開いてエディタの stdio に渡す。
	let ttyFd: number | null = null;
	try {
		if (process.platform !== "win32") {
			try {
				ttyFd = openSync("/dev/tty", "r+");
			} catch {
				// `ensureEditorAvailable()` が直前で通っていれば普通は失敗しないが、
				// 万が一失敗した場合は inherit にフォールバックする。
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
