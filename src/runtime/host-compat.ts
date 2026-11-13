import { createRequire } from "node:module";
import type { Context } from "@deepseek-ai/cordis";
import type {
  ToolExecutionInput,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools";

const require = createRequire(import.meta.url);
interface HostManifest {
  version: string;
  exports?: Record<string, unknown>;
}
const host = require("@deepseek-ai/dsh-tools/package.json") as HostManifest;
export function hostUsesLegacyAgentFactory() {
  return hostDispatchKind(host) === "single";
}

/** Use only a declared public entry. Never retry a failed policy/dispatch on another path. */
export function hostDispatchKind(
  manifest: HostManifest,
): "pipeline" | "single" {
  if (!/^0\.2\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
    throw Error("RUNTIME_HOST_UNSUPPORTED");
  if (
    Object.prototype.hasOwnProperty.call(manifest.exports ?? {}, "./pipeline")
  )
    return "pipeline";
  if (/^0\.2\.[01]-/.test(manifest.version)) return "single";
  throw Error("RUNTIME_HOST_UNSUPPORTED");
}

export async function executeHostTool(
  ctx: Context,
  input: ToolExecutionInput,
): Promise<ToolExecutionResult> {
  if (hostDispatchKind(host) === "single") {
    // 0.2.0/0.2.1 publicly execute a parsed invocation through their full policy pipeline.
    // A modern admission capability must never be silently dropped by a legacy API.
    if (input.toolSet !== undefined)
      throw Error("RUNTIME_HOST_ADMISSION_UNSUPPORTED");
    const tools = ctx.tools as unknown as {
      execute(input: ToolExecutionInput): Promise<ToolExecutionResult>;
    };
    return tools.execute(input);
  }
  const { ToolExecutionPipeline } = await import(
    "@deepseek-ai/dsh-tools/pipeline"
  );
  const pipeline = new ToolExecutionPipeline(ctx);
  const prepared = await pipeline.prepare(input);
  const outcome =
    prepared.kind === "dispatch"
      ? await pipeline.dispatch(prepared.exec)
      : prepared;
  return pipeline.complete(prepared.exec, outcome);
}
