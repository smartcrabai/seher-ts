import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { validateSettings } from "./validate.ts";

function parseJsonc(text: string): unknown {
	const errors: ParseError[] = [];
	const value = parse(text, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	});
	if (errors.length > 0) {
		const details = errors
			.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
			.join("; ");
		throw new Error(details);
	}
	return value;
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

function errorResponse(status: number, message: string): Response {
	return jsonResponse({ error: message }, status);
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

// Bun.file().text() throws ENOENT when the file is missing; map that to 404
// so callers can distinguish "no such file" from "bad JSON".
async function readJsonFile(
	path: string,
	notFoundMessage: string,
): Promise<Response> {
	let text: string;
	try {
		text = await Bun.file(path).text();
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return errorResponse(404, notFoundMessage);
		return errorResponse(500, errMessage(err));
	}
	try {
		return jsonResponse(parseJsonc(text));
	} catch (err) {
		return errorResponse(500, `invalid JSON in ${path}: ${errMessage(err)}`);
	}
}

export function getSettings(settingsPath: string): Promise<Response> {
	return readJsonFile(settingsPath, `settings file not found: ${settingsPath}`);
}

export function getSchema(schemaPath: string): Promise<Response> {
	return readJsonFile(schemaPath, "schema not found");
}

export async function putSettings(
	req: Request,
	settingsPath: string,
): Promise<Response> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await req.text());
	} catch (err) {
		return errorResponse(400, `invalid JSON: ${errMessage(err)}`);
	}
	const result = validateSettings(parsed);
	if (!result.ok) return errorResponse(400, result.error);
	try {
		await Bun.write(settingsPath, `${JSON.stringify(result.value, null, 2)}\n`);
	} catch (err) {
		return errorResponse(500, `failed to write settings: ${errMessage(err)}`);
	}
	return jsonResponse({ ok: true });
}
