/** Stable product identities and model-visible runtime policy. */
export const PRODUCT = Object.freeze({
    name: "萧何 / Xiao He",
    packageName: "@feng0531/dsh-execution-bus",
    presetId: "xiao-he-runtime",
    presetRowId: "preset-xiao-he-runtime",
    modeEntry: "@feng0531/dsh-execution-bus/mode",
    modePluginName: "xiao-he-runtime-mode",
});
const RUNTIME_STEP_SCHEMA = {
    type: "object",
    properties: {
        id: {
            type: "string",
            description: "步骤唯一 ID（字母开头，可含字母/数字/_-）",
        },
        tool: {
            type: "string",
            enum: ["read", "glob", "grep", "edit", "write", "pwsh"],
            description: "允许的宿主工具",
        },
        input: {
            type: "object",
            description: "宿主工具参数，按工具 schema 校验；不做前置结果插值，pwsh 禁止 run_in_background:true",
        },
        depends_on: {
            type: "array",
            items: { type: "string" },
            description: "依赖步骤 ID；全部成功后本步骤才执行",
        },
        retry: {
            type: "integer",
            minimum: 0,
            maximum: 3,
            description: "仅幂等工具 read/glob/grep 允许 >0；重试次数不含首次",
        },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 600000 },
    },
    required: ["id", "tool", "input"],
    additionalProperties: false,
};
export const RUNTIME_RUN_PARAMETERS = {
    type: "object",
    properties: {
        plan: {
            type: "object",
            properties: {
                goal: { type: "string", maxLength: 500 },
                concurrency: { type: "integer", minimum: 1, maximum: 4 },
                steps: {
                    type: "array",
                    items: RUNTIME_STEP_SCHEMA,
                    minItems: 1,
                    maxItems: 32,
                },
            },
            required: ["steps"],
            additionalProperties: false,
        },
        async: {
            type: "boolean",
            description: "true 时立即返回 runId，用 runtime_status/runtime_result 取回",
        },
    },
    required: ["plan"],
    additionalProperties: false,
};
export const RUNTIME_RUN_ID_PARAMETERS = {
    type: "object",
    properties: {
        runId: { type: "string", description: "runtime_run 返回的运行 ID" },
    },
    required: ["runId"],
    additionalProperties: false,
};
export const RUNTIME_STATUS_PARAMETERS = {
    type: "object",
    properties: {
        runId: {
            type: "string",
            description: "可选：指定运行 ID；省略时列出本会话最近运行",
        },
        limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "仅列表：每页条数，默认 20",
        },
        offset: {
            type: "integer",
            minimum: 0,
            maximum: 10000,
            description: "仅列表：跳过条数，默认 0",
        },
    },
    additionalProperties: false,
};
export const RUNTIME_RUN_DESCRIPTION = "萧何声明式运行时：提交 DAG 计划（steps：id/tool/input/depends_on/retry/timeout_ms），由程序按依赖并行执行、对只读步骤重试、逐步落盘。默认等待完成返回步骤状态；async:true 立即返回 runId，用 runtime_status/runtime_result 取回，runtime_cancel 取消。仅允许 read/glob/grep/edit/write/pwsh；副作用步骤不重试、崩溃后在途步骤标记 unknown（不做 exactly-once 回滚）。简单一次调用请直接用原工具。";
export const RUNTIME_STATUS_DESCRIPTION = "读取本会话的运行元数据：不带 runId 按 limit/offset 分页（默认 20/0）；带 runId 返回指定运行与步骤状态，不含结果。不要轮询正在等待的 runtime_run。";
export const RUNTIME_RESULT_DESCRIPTION = "读取指定运行已保存的步骤结果（单步结果超过 64KiB 时只返回 truncated/bytes 标记）。";
export const RUNTIME_CANCEL_DESCRIPTION = "请求取消指定运行：停止调度、向后发步骤传播取消；已开始的副作用步骤状态可能为 unknown。";
export const RUNTIME_RESUME_DESCRIPTION = "显式恢复 interrupted 运行：保留已保存成功步骤，只读在途步骤重排；若存在未知副作用，标记 failed/RUNTIME_INTERRUPTED 并停止整个恢复计划，不自动重发。";
export const RUNTIME_INSTRUCTIONS = "萧何声明式运行时：当任务能写成稳定的 DAG（读取/搜索/编辑/写入/命令，步骤间有明确依赖）时，用 runtime_run 提交计划，而不是在 run_code 里写循环或反复等待。独立步骤按批次并行；只读普通失败可 retry，超时不重试；depends_on 仅约束顺序，不注入结果；pwsh 禁止显式后台，自动转后台需取 jobId 用原生 Job 工具收集且下游不执行；运行记录落盘，可用 runtime_status/runtime_result/runtime_cancel/runtime_resume。副作用步骤不重试、崩溃后在途步骤可能 unknown，不保证 exactly-once；简单一次性操作仍用原工具或宿主后台 Job，不要为包装而包装。";
