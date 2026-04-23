// TODO(post-merge): replace with import from ../cli/args.
// This stub exists because Unit 9 was developed in parallel isolation;
// after all PRs land, delete this and use the real module.

export interface ParsedArgs {
	browser?: string | undefined;
	profile?: string | undefined;
	command?: string | undefined;
	provider?: string | undefined;
	model?: string | undefined;
	quiet: boolean;
	json: boolean;
	config?: string | undefined;
	priority: boolean;
	guiConfig: boolean;
	trailing: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
	// Minimal stub parser: just enough for tests to pass basic flags through.
	const out: ParsedArgs = {
		quiet: false,
		json: false,
		priority: false,
		guiConfig: false,
		trailing: [],
	};
	const trailing: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === undefined) continue;
		switch (a) {
			case "--quiet":
			case "-q":
				out.quiet = true;
				break;
			case "--json":
			case "-j":
				out.json = true;
				break;
			case "--priority":
				out.priority = true;
				break;
			case "--gui-config":
				out.guiConfig = true;
				break;
			case "--model":
			case "-m":
				out.model = argv[++i];
				break;
			case "--command":
				out.command = argv[++i];
				break;
			case "--provider":
				out.provider = argv[++i];
				break;
			case "--browser":
			case "-b":
				out.browser = argv[++i];
				break;
			case "--profile":
				out.profile = argv[++i];
				break;
			case "--config":
			case "-C":
				out.config = argv[++i];
				break;
			default:
				trailing.push(a);
		}
	}
	out.trailing = trailing;
	return out;
}
