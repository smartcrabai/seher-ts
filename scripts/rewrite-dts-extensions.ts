// Workaround for TS 5.9 bug: `rewriteRelativeImportExtensions` rewrites
// `.ts` -> `.js` in emitted JS but not in `.d.ts`. Patch the d.ts after build.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function* walk(dir: string): AsyncGenerator<string> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(path);
		else yield path;
	}
}

const distDir = process.argv[2] ?? "./dist";
const pattern = /(from\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g;

let touched = 0;
for await (const path of walk(distDir)) {
	if (!path.endsWith(".d.ts")) continue;
	const content = await readFile(path, "utf8");
	const rewritten = content.replace(pattern, "$1$2.js$3");
	if (rewritten !== content) {
		await writeFile(path, rewritten);
		touched++;
	}
}
console.log(`rewrote .ts -> .js in ${touched} d.ts file(s)`);
