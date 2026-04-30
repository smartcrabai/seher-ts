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

export async function editPromptInEditor(initial?: string): Promise<string> {
	const editor = process.env.EDITOR ?? "vim";
	const tmpPath = join(
		tmpdir(),
		`seher-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
	);
	const file = Bun.file(tmpPath);
	await Bun.write(file, initial ?? "");

	try {
		const proc = Bun.spawn([editor, tmpPath], {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`Editor '${editor}' exited with code ${code}`);
		}
		const contents = await Bun.file(tmpPath).text();
		return contents.trim();
	} finally {
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
