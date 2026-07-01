import { realpathSync, statSync } from "node:fs";
import { EFFORT_LEVELS, type EffortLevel } from "@seher-ts/sdk";
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
	/** Reasoning effort level, if `--effort` was given. */
	effortLevel?: EffortLevel;
	/** Canonicalized absolute working directory, if `--cwd` was given. */
	cwd?: string;
	/** Session id to resume, if `-r/--resume` was given. */
	resume?: string;
	quiet: boolean;
	help: boolean;
	version: boolean;
	/**
	 * `--show-resolution`: a dry-run mode that skips prompt resolution and
	 * only displays the selected provider/model/SDK.
	 */
	showResolution: boolean;
	/**
	 * Text emitted by commander for `--help` / `--version`. Present only when
	 * `help` or `version` is true. Already includes any trailing newline.
	 */
	output?: string;
	trailing: string[];
}

const DESCRIPTION =
	"Seher: pick the highest-priority coding agent and run a plan/build prompt";

// Session ids are used as file names and transcript search keys, so we only
// allow strict alphanumerics plus `-`/`_`, disallowing path separators /
// special characters such as `/` or `..`.
const RESUME_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface CommonOpts {
	provider?: string;
	model?: string;
	config?: string;
	timeout?: string;
	effort?: string;
	cwd?: string;
	resume?: string;
	quiet?: boolean;
	showResolution?: boolean;
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
			"--effort <level>",
			`Reasoning effort level (${EFFORT_LEVELS.join("/")})`,
		)
		.option(
			"--cwd <dir>",
			"Working directory for the agent (canonicalized; multi-turn sessions are bound to it)",
		)
		.option(
			"-r, --resume <id>",
			"Resume a prior session by id (printed as 'session: <id>' on a previous run)",
		)
		.option("-q, --quiet", "Suppress informational output", false)
		.option(
			"--show-resolution",
			"Show the selected provider/model/SDK without running the prompt",
		);
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

function parseEffortLevel(raw: string): EffortLevel {
	const normalized = raw.trim().toLowerCase();
	if (!EFFORT_LEVELS.includes(normalized as EffortLevel)) {
		throw new CommanderError(
			1,
			"seher.invalidEffort",
			`Invalid --effort value '${raw}': expected one of ${EFFORT_LEVELS.join(", ")}`,
		);
	}
	return normalized as EffortLevel;
}

/**
 * Canonicalizes `--cwd` and verifies it is a directory.
 * This matches the behavior of the Rust `args.rs::normalize`, so the
 * `session id` <-> `cwd` binding stays stable across symlinks/relative paths.
 */
function normalizeCwd(raw: string): string {
	let resolved: string;
	try {
		// `realpathSync.native` uses the OS's native realpath(3) and returns
		// the absolute path with symlinks resolved. It throws ENOENT if the
		// path does not exist.
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
		showResolution: opts.showResolution === true,
		trailing,
	};
	if (captured.length > 0) result.output = captured;
	if (opts.provider !== undefined) result.provider = opts.provider;
	if (opts.model !== undefined) result.model = opts.model;
	if (opts.config !== undefined) result.config = opts.config;
	if (opts.timeout !== undefined)
		result.timeoutMs = parseTimeoutMs(opts.timeout);
	if (opts.effort !== undefined)
		result.effortLevel = parseEffortLevel(opts.effort);
	// Skip cwd / resume validation so `--help` / `--version` can return early.
	// e.g. for a case like `seher --cwd /tmp --resume id --help` where the
	// user just wants to see help text, rejecting on value validation would
	// prevent the help text from being returned.
	if (!help && !version) {
		if (opts.cwd !== undefined) result.cwd = normalizeCwd(opts.cwd);
		if (opts.resume !== undefined) result.resume = normalizeResume(opts.resume);
	}
	return result;
}
