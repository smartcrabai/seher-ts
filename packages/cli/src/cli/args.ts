import { realpathSync, statSync } from "node:fs";
import { Command, CommanderError } from "commander";
import packageJson from "../../package.json" with { type: "json" };

const VERSION = (packageJson as { version?: string }).version ?? "unknown";

export type Mode = "plan" | "build";

export interface ParsedArgs {
	mode: Mode;
	provider?: string;
	model?: string;
	config?: string;
	timeoutMs?: number;
	/** Canonicalized absolute working directory, if `--cwd` was given. */
	cwd?: string;
	/** Session id to resume, if `-r/--resume` was given. */
	resume?: string;
	quiet: boolean;
	help: boolean;
	version: boolean;
	/**
	 * Text emitted by commander for `--help` / `--version`. Present only when
	 * `help` or `version` is true. Already includes any trailing newline.
	 */
	output?: string;
	trailing: string[];
}

const DESCRIPTION =
	"Seher: pick the highest-priority coding agent and run a plan/build prompt";

// セッション id はファイル名や transcript 検索キーに使われるため、`/` や `..` の
// ような path 区切り / 特殊文字を許さない厳格な英数 + `-`, `_` のみを許可する。
const RESUME_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface CommonOpts {
	provider?: string;
	model?: string;
	config?: string;
	timeout?: string;
	cwd?: string;
	resume?: string;
	quiet?: boolean;
}

function configureCommonOptions(cmd: Command): Command {
	return cmd
		.option("-p, --provider <name>", "Force a specific provider key")
		.option(
			"-m, --model <key>",
			"Use this model key instead of the default plan/build key",
		)
		.option("-c, --config <path>", "Path to YAML config file")
		.option(
			"-t, --timeout <ms>",
			"Per-run timeout in milliseconds (default: SDK default — usually none, Copilot 60_000)",
		)
		.option(
			"--cwd <dir>",
			"Working directory for the agent (canonicalized; multi-turn sessions are bound to it)",
		)
		.option(
			"-r, --resume <id>",
			"Resume a prior session by id (printed as 'session: <id>' on a previous run)",
		)
		.option("-q, --quiet", "Suppress informational output", false);
}

function parseTimeoutMs(raw: string): number {
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
		throw new CommanderError(
			1,
			"seher.invalidTimeout",
			`Invalid --timeout value '${raw}': expected a positive integer (ms)`,
		);
	}
	return n;
}

/**
 * `--cwd` を canonicalize し、ディレクトリであることを確認する。
 * Rust 版 `args.rs::normalize` の挙動と一致させ、
 * `session id` ↔ `cwd` の紐付けが symlink/相対パス越しでも安定するようにする。
 */
function normalizeCwd(raw: string): string {
	let resolved: string;
	try {
		// `realpathSync.native` は OS の native realpath(3) を使い、symlink を解決した
		// 絶対パスを返す。存在しない場合は ENOENT で throw する。
		resolved = realpathSync.native(raw);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new CommanderError(
			1,
			"seher.invalidCwd",
			`Invalid --cwd '${raw}': ${msg}`,
		);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(resolved);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new CommanderError(
			1,
			"seher.invalidCwd",
			`Invalid --cwd '${raw}': ${msg}`,
		);
	}
	if (!stat.isDirectory()) {
		throw new CommanderError(
			1,
			"seher.invalidCwd",
			`Invalid --cwd '${raw}': not a directory`,
		);
	}
	return resolved;
}

function normalizeResume(raw: string): string {
	if (raw.length === 0 || !RESUME_ID_PATTERN.test(raw)) {
		throw new CommanderError(
			1,
			"seher.invalidResume",
			`Invalid --resume value '${raw}': expected a session id (alphanumeric, '-', '_')`,
		);
	}
	return raw;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const program = new Command();
	let captured = "";

	let opts: CommonOpts = {};
	let positional: string[] = [];

	program
		.name("seher")
		.description(DESCRIPTION)
		.usage("[options] [plan|build] [prompt...]")
		.argument("[args...]", "Optional 'plan' or 'build' followed by prompt text")
		.version(VERSION, "-v, --version", "Show version information and exit")
		.helpOption("-h, --help", "Show this help and exit")
		.exitOverride()
		.configureOutput({
			writeOut: (str) => {
				captured += str;
			},
			writeErr: (str) => {
				captured += str;
			},
		});

	configureCommonOptions(program);

	program.action((args: string[], parsedOpts: CommonOpts) => {
		positional = args;
		opts = parsedOpts;
	});

	let help = false;
	let version = false;
	try {
		program.parse(argv, { from: "user" });
	} catch (e) {
		if (e instanceof CommanderError) {
			if (e.code === "commander.helpDisplayed" || e.code === "commander.help") {
				help = true;
			} else if (e.code === "commander.version") {
				version = true;
			} else {
				throw e;
			}
		} else {
			throw e;
		}
	}

	let mode: Mode = "build";
	let trailing = positional;
	if (positional[0] === "plan" || positional[0] === "build") {
		mode = positional[0] as Mode;
		trailing = positional.slice(1);
	}

	const result: ParsedArgs = {
		mode,
		quiet: opts.quiet ?? false,
		help,
		version,
		trailing,
	};
	if (captured.length > 0) result.output = captured;
	if (opts.provider !== undefined) result.provider = opts.provider;
	if (opts.model !== undefined) result.model = opts.model;
	if (opts.config !== undefined) result.config = opts.config;
	if (opts.timeout !== undefined)
		result.timeoutMs = parseTimeoutMs(opts.timeout);
	// `--help` / `--version` は早期 return できるよう、cwd / resume の検証はスキップ。
	// 例: `seher --cwd /tmp --resume id --help` のように help 確認したいケースで
	// 値検証で弾くと help テキストを返せなくなる。
	if (!help && !version) {
		if (opts.cwd !== undefined) result.cwd = normalizeCwd(opts.cwd);
		if (opts.resume !== undefined) result.resume = normalizeResume(opts.resume);
	}
	return result;
}
