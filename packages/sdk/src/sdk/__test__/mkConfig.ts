import type { Config } from "../../types.ts";

/**
 * Test helper: build a `Config` from a list of `ProviderEntry`-shaped
 * literals where `provider` is optional and defaults to `key`.
 */
export function mkConfig(
	...providers: Array<
		Omit<Config["providers"][number], "provider"> & { provider?: string }
	>
): Config {
	return {
		providers: providers.map((p) => ({ ...p, provider: p.provider ?? p.key })),
	};
}
