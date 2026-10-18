/** Stable product identities and policy. Historical IDs are compatibility contracts, not display names. */
export const PRODUCT = Object.freeze({
  name: "萧何 / Xiao He",
  packageName: "@feng0531/dsh-execution-bus",
  presetId: "execution-bus-test",
  presetRowId: "preset-execution-bus-test",
  modeEntry: "@feng0531/dsh-execution-bus/mode",
  modePluginName: "execution-bus-mode",
});
export const CORE_DEFAULTS = Object.freeze({
  concurrency: 2,
  queueLimit: 32,
  recordLimit: 256,
  resultBytes: 65536,
  retentionMs: 3600000,
});
export const ADMISSION_DEFAULTS = Object.freeze({
  sessionQueueLimit: 16,
  maxQueueWaitMs: 120000,
});
export const HANDLER_LIMITS = Object.freeze({
  readLines: 100,
  readPathChars: 2048,
  diagnosticDelayMs: 30000,
});
/** 调度策略：类别优先级 + 等待老化 + 长任务诊断阈值。 */
export const SCHEDULER_POLICY = Object.freeze({
  longRunningMs: 30000,
  queueAgingMs: 30000,
  queueClassOrder: Object.freeze({
    fs: 0,
    diagnostic: 1,
    command: 2,
    default: 3,
  }) as Readonly<Record<string, number>>,
});
/** 每个 Handler 的模型可见输入声明。只用于工具 schema/SDK 生成；运行时仍由 Handler.validate 严格校验。 */
const INPUT_SCHEMAS = {
  test: {
    type: "object",
    additionalProperties: false,
    required: ["delayMs", "fail"],
    properties: {
      delayMs: { type: "integer", description: "Diagnostic delay in milliseconds (0-30000)." },
      fail: { type: "boolean", description: "Settle as a controlled failure when true." },
    },
  },
  "host.read": {
    type: "object",
    additionalProperties: false,
    required: ["file_path"],
    properties: {
      file_path: { type: "string", description: "Path resolved against the session working directory." },
      offset: { type: "integer", description: "1-based first line to read." },
      limit: { type: "integer", description: "Maximum lines to read (<=100)." },
    },
  },
  "host.glob": {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Glob pattern; a bare pattern matches basenames at any depth." },
      path: { type: "string", description: "Directory to search; defaults to the session working directory." },
    },
  },
  "host.grep": {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Ripgrep regular expression." },
      path: { type: "string", description: "File or directory to search; defaults to the session working directory." },
      include: { type: "string", description: "One positive glob filter; negation and comma lists are rejected." },
    },
  },
  "host.edit": {
    type: "object",
    additionalProperties: false,
    required: ["file_path", "old_string", "new_string"],
    properties: {
      file_path: { type: "string", description: "File to edit." },
      old_string: { type: "string", description: "Literal text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence." },
    },
  },
  "host.write": {
    type: "object",
    additionalProperties: false,
    required: ["file_path", "content"],
    properties: {
      file_path: { type: "string", description: "File to write." },
      content: { type: "string", description: "Full file content." },
    },
  },
  "host.pwsh": {
    type: "object",
    additionalProperties: false,
    required: ["description", "command"],
    properties: {
      description: { type: "string", description: "Clear, concise description of what the command does (shown in the UI)." },
      command: { type: "string", description: "PowerShell command to execute." },
      timeoutMs: { type: "number", description: "Positive timeout in milliseconds." },
      workdir: { type: "string", description: "Working directory; defaults to the session working directory." },
      run_in_background: { type: "boolean", description: "Return a host Job id immediately instead of waiting." },
      sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"], description: "Narrowest wider sandbox mode; must be paired with justification." },
      justification: { type: "string", description: "Required with sandbox_permissions; one sentence of reason." },
    },
  },
} as const;
/** Handler 名列表同时决定 request payload 的联合分支顺序。 */
const HANDLER_NAMES = [
  "host.read",
  "host.glob",
  "host.grep",
  "host.edit",
  "host.write",
  "host.pwsh",
  "test",
] as const;
/** 简化调用（0.11.0）：{requestId, handler, input} 或 {requestId, type}；
 *  完整 v1 消息仍被运行时接受，但不再进入模型可见 schema。 */
const REQUEST_ID_PROP = { type: "string" } as const;
const MESSAGE_ID_PROP = { type: "string" } as const;
export const REQUEST_PARAMETERS = {
  oneOf: [
    ...HANDLER_NAMES.map((handler) => ({
      type: "object" as const,
      additionalProperties: false as const,
      required: ["requestId", "handler", "input"],
      properties: {
        requestId: REQUEST_ID_PROP,
        messageId: MESSAGE_ID_PROP,
        handler: { type: "string" as const, const: handler },
        input: INPUT_SCHEMAS[handler],
      },
    })),
    {
      type: "object" as const,
      additionalProperties: false as const,
      required: ["requestId", "type"],
      properties: {
        requestId: REQUEST_ID_PROP,
        messageId: MESSAGE_ID_PROP,
        type: {
          type: "string" as const,
          enum: ["status", "result", "cancel"],
          description:
            "Read the saved snapshot or request cancellation for this requestId.",
        },
      },
    },
  ],
} as const;
export const STATE_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
export const REQUEST_DESCRIPTION =
  "萧何 / Xiao He. Submit a request and WAIT for its terminal snapshot; the simplified call takes {requestId, handler, input} (messageId optional) and control calls take {requestId, type:\"status\"|\"result\"|\"cancel\"}. Use only when coordination helps: the same logical operation may be retried or deduplicated (reuse requestId), work must outlive a run_code budget end, or multiple steps must await one execution. Duration alone is not a reason — for a one-off long command use the original tool or its background Job. A PTC program end only stops waiting: accepted work continues and the same requestId can be retrieved with type:\"result\" or cancelled. Do not poll status inside the same run_code program as an unfinished request: end that program and retrieve in a later step. The snapshot may contain reused:true when this call attached to an existing execution. The full v1 envelope is still accepted. Diagnostic handler only: test {delayMs:0..30000,fail:boolean}; never use it for real work. Acceptance is volatile, not success. No polling or restart resume.";
export const MODE_INSTRUCTIONS =
  "你正在萧何模式中。这不是角色扮演。保留宿主 PTC 的日常工具能力与权限规则。普通编辑、搜索、命令、安装和其他工作使用原工具，不要声称此模式只读。execution_bus 只在能获得协调收益时使用：① 同一逻辑操作可能重复提交或需要重试核对（沿用同一 requestId，只执行一次）；② 任务需要在 run_code 时间预算结束后继续或跨步骤取回；③ 多个步骤/等待者需要同一执行结果。仅\"操作耗时长\"不是理由：一次性长命令用原工具或宿主后台 Job。其余普通任务直接用原工具，不要为简单调用增加包装。实际业务 Handler 为 host.read、host.glob、host.grep（只读，可复用终态结果）与 host.edit、host.write、host.pwsh（有副作用，终态结果不可复用）；test 仅用于用户明确要求的诊断，不做真实工作。简化调用示例：await tools.execution_bus({requestId:\"<逻辑操作编号>\", handler:\"host.pwsh\", input:{description:\"运行测试\", command:\"pnpm test\", timeoutMs:120000}})；预算中断后用 await tools.execution_bus({requestId:\"<同一编号>\", type:\"result\"}) 取回；同一逻辑操作重发沿用 requestId，messageId 可省略（自动生成）。返回快照出现 reused:true 表示本次调用复用了已有执行。注意：同一 run_code 程序内，未完成的 request 会阻塞后发工具调用的结果提交；跨步骤取回请让启动步骤尽早结束程序，下一步再用同一 requestId 的 status/result 或重发 request；不要在同一程序里对未完成请求轮询状态。通过 run_code 调用，受原有时间预算约束。每会话排队上限 " +
  ADMISSION_DEFAULTS.sessionQueueLimit +
  "，排队超过 " +
  ADMISSION_DEFAULTS.maxQueueWaitMs / 1000 +
  " 秒且未执行会返回 QUEUE_WAIT_TIMEOUT，不自动重试。execution_bus_state 只用于用户明确诊断本会话元数据，不循环查询。请求只提交一次并等待结果，同一逻辑操作重发沿用 requestId。PTC 程序结束或 run_code 时间预算到期时，已受理请求只停止等待、继续执行；用同一 requestId 的 status/result 取回，或用 cancel 取消；用户/会话中断仍会请求取消执行。cancelRequested 不等于已取消，unknown 不代表执行失败，不承诺跨重启恢复。后台命令返回 Job ID 不代表已经完成。";
// —— 声明式运行时（1.0 方向） ——
const RUNTIME_STEP_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "步骤唯一 ID（字母开头，可含字母/数字/_-）" },
    tool: {
      type: "string",
      enum: ["read", "glob", "grep", "edit", "write", "pwsh"],
      description: "允许的宿主工具",
    },
    input: { type: "object", description: "宿主工具参数，按工具 schema 校验" },
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
} as const;
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
} as const;
export const RUNTIME_RUN_ID_PARAMETERS = {
  type: "object",
  properties: {
    runId: {
      type: "string",
      description: "runtime_run 返回的运行 ID",
    },
  },
  required: ["runId"],
  additionalProperties: false,
} as const;
export const RUNTIME_STATUS_PARAMETERS = {
  type: "object",
  properties: {
    runId: {
      type: "string",
      description: "可选：指定运行 ID；省略时列出最近运行",
    },
  },
  additionalProperties: false,
} as const;
export const RUNTIME_STATE_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
export const RUNTIME_RUN_DESCRIPTION =
  "萧何声明式运行时：提交 DAG 计划（steps：id/tool/input/depends_on/retry/timeout_ms），由程序按依赖并行执行、对只读步骤重试、逐步落盘。默认等待完成返回步骤状态；async:true 立即返回 runId，用 runtime_status/runtime_result 取回，runtime_cancel 取消。仅允许 read/glob/grep/edit/write/pwsh；副作用步骤不重试、崩溃后在途步骤标记 unknown（不做 exactly-once 回滚）。简单一次调用请直接用原工具。";
export const RUNTIME_STATUS_DESCRIPTION =
  "读取本会话的运行元数据：不带 runId 列出最近运行，带 runId 返回指定运行与步骤状态（不含结果）。不要轮询正在等待的 runtime_run。";
export const RUNTIME_RESULT_DESCRIPTION =
  "读取指定运行已保存的步骤结果（单步结果超过 64KiB 时只返回 truncated/bytes 标记）。";
export const RUNTIME_CANCEL_DESCRIPTION =
  "请求取消指定运行：停止调度、向后发步骤传播取消；已开始的副作用步骤状态可能为 unknown。";
export const RUNTIME_RESUME_DESCRIPTION =
  "恢复 interrupted 运行：只读步骤重新排队，副作用在途步骤标记 failed（RUNTIME_INTERRUPTED）；不自动执行，需显式调用。";
export const RUNTIME_INSTRUCTIONS =
  "萧何声明式运行时：当任务能写成稳定的 DAG（读取/搜索/编辑/写入/命令，步骤间有明确依赖）时，用 runtime_run 提交计划，而不是在 run_code 里写循环或反复等待。独立步骤会并行；只读步骤可 retry；运行记录落盘，可用 runtime_status/runtime_result/runtime_cancel/runtime_resume。副作用步骤不重试、崩溃后在途步骤可能 unknown，不保证 exactly-once；简单一次性操作仍用原工具或宿主后台 Job，不要为包装而包装。";

