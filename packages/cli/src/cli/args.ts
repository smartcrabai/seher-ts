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

interface CommonOpts {
	provider?: string;
	model?: string;
	config?: string;
	timeout?: string;
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
	return result;
}
