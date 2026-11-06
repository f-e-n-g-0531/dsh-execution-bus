import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  RUNTIME_CAPABILITIES_DESCRIPTION,
  RUNTIME_CAPABILITIES_PARAMETERS,
  RUNTIME_CANCEL_DESCRIPTION,
  RUNTIME_RESULT_DESCRIPTION,
  RUNTIME_RESULT_PARAMETERS,
  RUNTIME_REVIEW_DESCRIPTION,
  RUNTIME_REVIEW_PARAMETERS,
  RUNTIME_RESUME_DESCRIPTION,
  RUNTIME_RUN_DESCRIPTION,
  RUNTIME_RUN_ID_PARAMETERS,
  RUNTIME_RUN_PARAMETERS,
  RUNTIME_STATUS_DESCRIPTION,
  RUNTIME_STATUS_PARAMETERS,
} from "./product.js";
import { RuntimeService } from "./runtime/service.js";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
  presentRuntimeResult,
} from "./presentation.js";

export const name = "xiao-he-runtime";
// Worker creation and setup must use declared services on the mounting context.
export const inject = [
  "tools",
  "systemPrompt",
  "agents",
  "agentPresets",
  "workingDirectory",
];

/** 声明式运行时插件：只暴露 runtime_* 工具，执行/持久化在 RuntimeService。 */
export function apply(ctx: Context) {
  const runtime = new RuntimeService(ctx);
  ctx.effect(() => () => runtime.dispose());

  const register = (
    toolName: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (raw: unknown, exec: ToolRunContext) => unknown,
  ) => {
    ctx.tools.register({
      name: toolName,
      description,
      parameters,
      output: {
        schema: RUNTIME_OUTPUT_SCHEMAS[toolName],
        presentationMeta: runtimePresentationMeta,
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      presentResult: presentRuntimeResult,
      async execute(raw: unknown, exec: ToolRunContext) {
        return execute(raw, exec);
      },
    });
  };

  register(
    "runtime_capabilities",
    RUNTIME_CAPABILITIES_DESCRIPTION,
    RUNTIME_CAPABILITIES_PARAMETERS,
    (raw, exec) => runtime.capabilities(raw, exec),
  );
  register(
    "runtime_review",
    RUNTIME_REVIEW_DESCRIPTION,
    RUNTIME_REVIEW_PARAMETERS,
    (raw, exec) => runtime.review(raw, exec),
  );
  register(
    "runtime_run",
    RUNTIME_RUN_DESCRIPTION,
    RUNTIME_RUN_PARAMETERS,
    (raw, exec) => runtime.run(raw, exec),
  );
  register(
    "runtime_status",
    RUNTIME_STATUS_DESCRIPTION,
    RUNTIME_STATUS_PARAMETERS,
    (raw, exec) => runtime.status(raw, exec),
  );
  register(
    "runtime_result",
    RUNTIME_RESULT_DESCRIPTION,
    RUNTIME_RESULT_PARAMETERS,
    (raw, exec) => runtime.result(raw, exec),
  );
  register(
    "runtime_cancel",
    RUNTIME_CANCEL_DESCRIPTION,
    RUNTIME_RUN_ID_PARAMETERS,
    (raw, exec) => runtime.cancel(raw, exec),
  );
  register(
    "runtime_resume",
    RUNTIME_RESUME_DESCRIPTION,
    RUNTIME_RUN_ID_PARAMETERS,
    (raw, exec) => runtime.resume(raw, exec),
  );
}
