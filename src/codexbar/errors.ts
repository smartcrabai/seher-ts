export class CodexBarError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(message: string, exitCode: number | null, stderr: string) {
		super(message);
		this.name = "CodexBarError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

export class CodexBarTimeoutError extends CodexBarError {
	constructor(message: string, stderr: string) {
		super(message, 4, stderr);
		this.name = "CodexBarTimeoutError";
	}
}

export class CodexBarNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexBarNotFoundError";
	}
}
