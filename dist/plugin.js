import { RUNTIME_HANDOFF_DESCRIPTION, RUNTIME_HANDOFF_PARAMETERS, RUNTIME_DECISION_DESCRIPTION, RUNTIME_DECISION_PARAMETERS, RUNTIME_QUERY_DESCRIPTION, RUNTIME_QUERY_PARAMETERS, RUNTIME_TASK_DESCRIPTION, RUNTIME_TASK_PARAMETERS, RUNTIME_NOTIFICATION_DESCRIPTION, RUNTIME_NOTIFICATION_PARAMETERS, RUNTIME_ACKNOWLEDGE_DESCRIPTION, RUNTIME_ACKNOWLEDGE_PARAMETERS, RUNTIME_CAPABILITIES_DESCRIPTION, RUNTIME_CAPABILITIES_PARAMETERS, RUNTIME_CANCEL_DESCRIPTION, RUNTIME_RESULT_DESCRIPTION, RUNTIME_RESULT_PARAMETERS, RUNTIME_REVIEW_DESCRIPTION, RUNTIME_REVIEW_PARAMETERS, RUNTIME_RESUME_DESCRIPTION, RUNTIME_RUN_DESCRIPTION, RUNTIME_RUN_ID_PARAMETERS, RUNTIME_RUN_PARAMETERS, RUNTIME_STATUS_DESCRIPTION, RUNTIME_STATUS_PARAMETERS, } from "./product.js";
import { RuntimeService, describeCapabilities } from "./runtime/service.js";
import { RUNTIME_OUTPUT_SCHEMAS, runtimePresentationMeta, presentRuntimeResult, } from "./presentation.js";
// Public host integration API; no model tool can install or invoke a sender.
export { RuntimeService };
export { BusinessPromptHistory } from "./runtime/prompt-history.js";
export { ModelWaitObserver } from "./runtime/model-wait.js";
export { createBusinessPromptOverrides, previewBusinessPrompt, compareBusinessPrompts, } from "./runtime/prompt-preview.js";
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
export function apply(ctx) {
    // Mounting a preset must not acquire storage or fail because a crashed host
    // left its owner lock behind. Runtime tools still fail closed on first use.
    let instance;
    let closed = false;
    const runtime = () => {
        if (closed)
            throw Error("CLOSED");
        try {
            return (instance ??= new RuntimeService(ctx));
        }
        catch (error) {
            if (error instanceof Error && error.message === "RUNTIME_ROOT_LOCKED") {
                throw Object.assign(new Error("RUNTIME_ROOT_LOCKED: 存储所有权冲突；先由操作者核对原宿主及后台 Job 是否仍在运行。不要自动删除锁、重试计划或重放未知副作用；能力说明仍可用，容量未知。"), {
                    code: "RUNTIME_ROOT_LOCKED",
                    action: "operator_reconciliation_required",
                    retryable: false,
                });
            }
            throw error;
        }
    };
    ctx.effect(() => () => {
        closed = true;
        return instance?.dispose();
    });
    const register = (toolName, description, parameters, execute) => {
        ctx.tools.register({
            name: toolName,
            description,
            parameters,
            output: {
                schema: RUNTIME_OUTPUT_SCHEMAS[toolName],
                presentationMeta: runtimePresentationMeta,
                render: (_args, value) => [
                    { type: "text", text: JSON.stringify(value) },
                ],
            },
            presentResult: presentRuntimeResult,
            async execute(raw, exec) {
                return execute(raw, exec);
            },
        });
    };
    register("runtime_handoff", RUNTIME_HANDOFF_DESCRIPTION, RUNTIME_HANDOFF_PARAMETERS, (raw, exec) => runtime().handoff(raw, exec));
    register("runtime_decision", RUNTIME_DECISION_DESCRIPTION, RUNTIME_DECISION_PARAMETERS, (raw, exec) => runtime().decision(raw, exec));
    register("runtime_query", RUNTIME_QUERY_DESCRIPTION, RUNTIME_QUERY_PARAMETERS, (raw, exec) => runtime().query(raw, exec));
    register("runtime_task", RUNTIME_TASK_DESCRIPTION, RUNTIME_TASK_PARAMETERS, (raw, exec) => runtime().task(raw, exec));
    register("runtime_notification", RUNTIME_NOTIFICATION_DESCRIPTION, RUNTIME_NOTIFICATION_PARAMETERS, (raw, exec) => runtime().notification(raw, exec));
    register("runtime_capabilities", RUNTIME_CAPABILITIES_DESCRIPTION, RUNTIME_CAPABILITIES_PARAMETERS, (raw, exec) => {
        if (closed)
            throw Error("CLOSED");
        return instance ? instance.capabilities(raw, exec) : describeCapabilities(raw, exec);
    });
    register("runtime_acknowledge", RUNTIME_ACKNOWLEDGE_DESCRIPTION, RUNTIME_ACKNOWLEDGE_PARAMETERS, (raw, exec) => runtime().acknowledge(raw, exec));
    register("runtime_review", RUNTIME_REVIEW_DESCRIPTION, RUNTIME_REVIEW_PARAMETERS, (raw, exec) => runtime().review(raw, exec));
    register("runtime_run", RUNTIME_RUN_DESCRIPTION, RUNTIME_RUN_PARAMETERS, (raw, exec) => runtime().run(raw, exec));
    register("runtime_status", RUNTIME_STATUS_DESCRIPTION, RUNTIME_STATUS_PARAMETERS, (raw, exec) => runtime().status(raw, exec));
    register("runtime_result", RUNTIME_RESULT_DESCRIPTION, RUNTIME_RESULT_PARAMETERS, (raw, exec) => runtime().result(raw, exec));
    register("runtime_cancel", RUNTIME_CANCEL_DESCRIPTION, RUNTIME_RUN_ID_PARAMETERS, (raw, exec) => runtime().cancel(raw, exec));
    register("runtime_resume", RUNTIME_RESUME_DESCRIPTION, RUNTIME_RUN_ID_PARAMETERS, (raw, exec) => runtime().resume(raw, exec));
}
