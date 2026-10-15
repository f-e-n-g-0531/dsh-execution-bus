import type { Context } from "@deepseek-ai/cordis";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { apply as applyBus } from "./plugin.js";
export const name = "execution-bus-test-mode";
export const inject = ["tools", "jobs"];
/** Must be mounted inside the host's preset scope, never in the global composition. */
export function apply(ctx: Context) {
  if (scopeOf(ctx) === undefined)
    throw Error("Execution Bus test mode requires an Agent preset scope");
  ctx.tools.presentAs("native");
  const allowed = new Set([
    "execution_bus",
    "read",
    "job_list",
    "job_output",
    "job_kill",
  ]);
  // Scope-local file suite also declares write/edit; the execution guard denies them.
  // restrict() only accepts known GLOBAL tool names, so it cannot filter sibling preset rows.
  // Restriction filters inherited tools; a guard also fences tools registered by sibling preset rows.
  ctx.tools.guard((exec) =>
    allowed.has(exec.name)
      ? undefined
      : "Execution Bus test mode allows only bus, read and job controls",
  );
  applyBus(ctx);
}
