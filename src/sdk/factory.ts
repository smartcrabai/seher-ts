import { ClaudeSDK, type ClaudeSDKConfig } from "./claude.ts";
import { CodexSDK, type CodexSDKConfig } from "./codex.ts";
import type { SdkKind, SeherSDK } from "./types.ts";

export type CreateSDKConfig = ClaudeSDKConfig & CodexSDKConfig;

export function createSDK(
	kind: SdkKind,
	config: CreateSDKConfig = {},
): SeherSDK {
	switch (kind) {
		case "claude":
			return new ClaudeSDK(config);
		case "codex":
			return new CodexSDK(config);
	}
}

export function createSDKFromAgent(
	agent: { sdk?: SdkKind | null },
	config: CreateSDKConfig = {},
): SeherSDK | null {
	if (agent.sdk === undefined || agent.sdk === null) return null;
	return createSDK(agent.sdk, config);
}
