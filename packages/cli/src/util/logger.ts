export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface CreateLoggerOptions {
	quiet?: boolean;
	stderr?: (text: string) => void;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
	const quiet = opts.quiet ?? false;
	const write = opts.stderr ?? ((text: string) => process.stderr.write(text));
	const ln = (msg: string) =>
		msg.endsWith("\n") ? write(msg) : write(`${msg}\n`);
	return {
		info(msg: string) {
			if (quiet) return;
			ln(msg);
		},
		warn(msg: string) {
			ln(msg);
		},
		error(msg: string) {
			ln(msg);
		},
	};
}
