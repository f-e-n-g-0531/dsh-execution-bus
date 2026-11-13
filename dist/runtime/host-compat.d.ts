import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecutionInput, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
interface HostManifest {
    version: string;
    exports?: Record<string, unknown>;
}
export declare function hostUsesLegacyAgentFactory(): boolean;
/** Use only a declared public entry. Never retry a failed policy/dispatch on another path. */
export declare function hostDispatchKind(manifest: HostManifest): "pipeline" | "single";
export declare function executeHostTool(ctx: Context, input: ToolExecutionInput): Promise<ToolExecutionResult>;
export {};
