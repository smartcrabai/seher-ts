export interface Logger {
	info(msg: string): void;
	warn(msg: string): void;
	error(msg: string): void;
}

export interface CreateLoggerOptions {
	quiet?: boolean;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
	const quiet = opts.quiet ?? false;
	return {
		info(msg: string) {
			if (quiet) return;
			console.error(msg);
		},
		warn(msg: string) {
			console.error(msg);
		},
		error(msg: string) {
			console.error(msg);
		},
	};
}
