import { Command, CommanderError } from "commander";
import packageJson from "../../package.json" with { type: "json" };

const VERSION = (packageJson as { version?: string }).version ?? "unknown";

export type Mode = "plan" | "build";

export interface ParsedArgs {
	mode: Mode;
	provider?: string;
	model?: string;
	config?: string;
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
		.option("-q, --quiet", "Suppress informational output", false);
}

/**
 * commander has no first-class default subcommand, so we sniff the first
 * non-flag token. If it is `plan` or `build`, leave argv alone; otherwise
 * inject `build` so the rest of the flags/prompt are parsed against that
 * subcommand.
 */
function withDefaultMode(argv: string[]): string[] {
	for (const tok of argv) {
		if (tok === "--") break;
		if (tok === "-h" || tok === "--help") return argv;
		if (tok === "-v" || tok === "--version") return argv;
		if (tok === "plan" || tok === "build") return argv;
		if (!tok.startsWith("-")) return ["build", ...argv];
	}
	return argv;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const program = new Command();
	let captured = "";

	let mode: Mode = "build";
	let common: CommonOpts = {};
	let trailing: string[] = [];

	const handleSubcommand =
		(m: Mode) =>
		(rest: string[], opts: CommonOpts): void => {
			mode = m;
			common = opts;
			trailing = rest;
		};

	program
		.name("seher")
		.description(DESCRIPTION)
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

	configureCommonOptions(
		program
			.command("plan")
			.description(
				"Generate an implementation plan, edit it, then build from approval",
			)
			.argument("[prompt...]", "Prompt text (joined with spaces)"),
	).action(handleSubcommand("plan"));

	configureCommonOptions(
		program
			.command("build", { isDefault: true })
			.description("Stream the prompt through the resolved agent")
			.argument("[prompt...]", "Prompt text (joined with spaces)"),
	).action(handleSubcommand("build"));

	let help = false;
	let version = false;
	try {
		program.parse(withDefaultMode(argv), { from: "user" });
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

	const result: ParsedArgs = {
		mode,
		quiet: common.quiet ?? false,
		help,
		version,
		trailing,
	};
	if (captured.length > 0) result.output = captured;
	if (common.provider !== undefined) result.provider = common.provider;
	if (common.model !== undefined) result.model = common.model;
	if (common.config !== undefined) result.config = common.config;
	return result;
}
