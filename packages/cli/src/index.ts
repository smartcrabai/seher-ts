#!/usr/bin/env bun
import { runSeher } from "./main.ts";

runSeher(Bun.argv.slice(2))
	.then((code) => {
		process.exit(code);
	})
	.catch((e) => {
		console.error(e);
		process.exit(1);
	});
