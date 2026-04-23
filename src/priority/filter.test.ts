import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "../schedule/types.ts";
import { filterAgents } from "./filter.ts";

function makeAgent(command: string, providerName?: string): AgentConfig {
	return {
		command,
		provider: providerName
			? { kind: "explicit", name: providerName }
			: { kind: "inferred" },
		active: null,
		inactive: null,
	};
}

describe("filterAgents", () => {
	const agents: AgentConfig[] = [
		makeAgent("claude"),
		makeAgent("codex"),
		makeAgent("opencode", "copilot"),
		makeAgent("opencode", "glm"),
	];

	test("no filters returns all agents", () => {
		expect(filterAgents(agents, {}).length).toBe(4);
	});

	test("filter by command", () => {
		const result = filterAgents(agents, { command: "claude" });
		expect(result.length).toBe(1);
		expect(result[0]?.command).toBe("claude");
	});

	test("filter by resolved provider", () => {
		const result = filterAgents(agents, { provider: "copilot" });
		expect(result.length).toBe(1);
		expect(result[0]?.command).toBe("opencode");
	});

	test("filter by command and provider combined", () => {
		const result = filterAgents(agents, {
			command: "opencode",
			provider: "glm",
		});
		expect(result.length).toBe(1);
		expect(result[0]?.command).toBe("opencode");
	});

	test("no match returns empty", () => {
		expect(filterAgents(agents, { command: "nonexistent" }).length).toBe(0);
	});

	test("inferred provider resolves from command", () => {
		// claude command with inferred provider -> provider "claude".
		const result = filterAgents(agents, { provider: "claude" });
		expect(result.length).toBe(1);
		expect(result[0]?.command).toBe("claude");
	});
});
