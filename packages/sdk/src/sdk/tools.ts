import type { z } from "zod";

/**
 * In-process tool registered with SeherSDK and forwarded to provider SDKs that
 * support it (Claude, Copilot, Kimi). Codex / Cursor / OpenCode do not support
 * runtime tool registration; passing tools to those providers logs a warning
 * and the tools are ignored.
 *
 * `parameters` must be a `z.object({...})` so each provider's expected shape can
 * be derived: Claude needs the raw `ZodRawShape` (`parameters.shape`), Kimi
 * needs the `ZodObject` itself, Copilot accepts any `ZodSchema`-like.
 */
export interface SeherTool<
	T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
	name: string;
	description: string;
	parameters: T;
	handler: (args: z.infer<T>) => Promise<string> | string;
}
