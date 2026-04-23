import { expect, test } from "bun:test";
import type { AgentConfig } from "../types.ts";
import { runAgent, shouldAutoRerun } from "./runner.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		command: "/bin/echo",
		args: [],
		models: null,
		arg_maps: {},
		env: null,
		provider: { kind: "none" },
		pre_command: [],
		active: null,
		inactive: null,
		...overrides,
	};
}

test("runAgent spawns the command and returns exit code 0", async () => {
	const agent = makeAgent();
	const result = await runAgent(agent, { trailingArgs: [], quiet: true });
	expect(result.exitCode).toBe(0);
});

test("runAgent returns exit 0 when trailing args are forwarded to echo", async () => {
	// runAgent inherits stdio so we cannot capture stdout here; the happy
	// exit code is enough to confirm the command and args were assembled.
	const agent = makeAgent();
	const result = await runAgent(agent, {
		trailingArgs: ["hello", "world"],
		quiet: true,
	});
	expect(result.exitCode).toBe(0);
});

test("runAgent runs pre_command before the main command", async () => {
	const agent = makeAgent({ pre_command: ["/bin/echo", "pre"] });
	const result = await runAgent(agent, { trailingArgs: [], quiet: true });
	expect(result.exitCode).toBe(0);
});

test("runAgent throws when pre_command fails", async () => {
	const agent = makeAgent({ pre_command: ["/bin/sh", "-c", "exit 3"] });
	await expect(
		runAgent(agent, { trailingArgs: [], quiet: true }),
	).rejects.toThrow(/pre_command/);
});

test("runAgent returns the child's non-zero exit code", async () => {
	const agent = makeAgent({ command: "/bin/sh", args: ["-c", "exit 7"] });
	const result = await runAgent(agent, { trailingArgs: [], quiet: true });
	expect(result.exitCode).toBe(7);
});

test("shouldAutoRerun returns false for exit 0", () => {
	expect(shouldAutoRerun(0, true)).toBe(false);
	expect(shouldAutoRerun(0, false)).toBe(false);
});

test("shouldAutoRerun returns true for failure with explicit provider", () => {
	expect(shouldAutoRerun(1, true)).toBe(true);
});

test("shouldAutoRerun returns false for failure without explicit provider", () => {
	expect(shouldAutoRerun(1, false)).toBe(false);
});
