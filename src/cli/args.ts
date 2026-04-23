import { Command } from "commander";

export interface ParsedArgs {
	browser?: string;
	profile?: string;
	command?: string;
	provider?: string;
	model?: string;
	quiet: boolean;
	json: boolean;
	config?: string;
	priority: boolean;
	guiConfig: boolean;
	trailing: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
	const program = new Command();
	program
		.name("seher")
		.description(
			"CLI tool for Claude.ai, Codex, and Copilot rate limit monitoring",
		)
		.helpOption(false)
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.enablePositionalOptions()
		.passThroughOptions()
		.option("-b, --browser <name>", "Browser to use")
		.option("--profile <name>", "Browser profile name")
		.option("--command <name>", "Filter agents by command name")
		.option("--provider <name>", "Filter agents by provider name")
		.option("-m, --model <key>", "Model level to use")
		.option("-q, --quiet", "Suppress informational output", false)
		.option("-j, --json", "Output provider usage as JSON and exit", false)
		.option("-C, --config <path>", "Path to settings file")
		.option("--priority", "Show priority order and exit", false)
		.option("--gui-config", "Open the web-based config editor and exit", false)
		.argument("[trailing...]", "Additional arguments to pass to the agent");

	program.parse(argv, { from: "user" });

	const opts = program.opts<{
		browser?: string;
		profile?: string;
		command?: string;
		provider?: string;
		model?: string;
		quiet?: boolean;
		json?: boolean;
		config?: string;
		priority?: boolean;
		guiConfig?: boolean;
	}>();

	const trailing = program.args.slice();

	const result: ParsedArgs = {
		quiet: opts.quiet ?? false,
		json: opts.json ?? false,
		priority: opts.priority ?? false,
		guiConfig: opts.guiConfig ?? false,
		trailing,
	};
	if (opts.browser !== undefined) result.browser = opts.browser;
	if (opts.profile !== undefined) result.profile = opts.profile;
	if (opts.command !== undefined) result.command = opts.command;
	if (opts.provider !== undefined) result.provider = opts.provider;
	if (opts.model !== undefined) result.model = opts.model;
	if (opts.config !== undefined) result.config = opts.config;
	return result;
}
