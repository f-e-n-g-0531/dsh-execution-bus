import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { RUNTIME_TOOLS } from "../../dist/runtime/plan.js";

// Keep service fault/cancellation handlers at the tool-body boundary while using
// the real registry and prepare/dispatch/complete pipeline. No executor stub or
// production test-only switch is involved. invoke receives the pipeline call
// (name, arguments, signal, agent, parent, rootCallId, token, toolSet, ...).
export function createServiceContext(invoke) {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx);
  for (const name of RUNTIME_TOOLS) {
    ctx.tools.register({
      name,
      description: "Service fixture " + name,
      parameters: { type: "object", additionalProperties: true },
      output: { schema: {}, render: () => [] },
      async execute(_input, call) {
        return invoke(call);
      },
    });
  }
  return ctx;
}
