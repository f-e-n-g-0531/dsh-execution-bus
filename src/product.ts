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
/** request 的 {handler,input} 判别联合；控制消息为空对象。 */
export const PAYLOAD_SCHEMA = {
  description:
    "request 必须匹配某个 Handler 的 {handler,input}；status/result/cancel 的 payload 必须为空对象 {}。",
  oneOf: [
    ...HANDLER_NAMES.map((handler) => ({
      type: "object" as const,
      additionalProperties: false as const,
      required: ["handler", "input"],
      properties: {
        handler: { type: "string" as const, const: handler },
        input: INPUT_SCHEMAS[handler],
      },
    })),
    { type: "object" as const, additionalProperties: false as const, properties: {} },
  ],
} as const;
export const REQUEST_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "messageId", "requestId", "type", "payload"],
  properties: {
    protocolVersion: { type: "integer", const: 1 },
    messageId: {
      type: "string",
      description: "Unique id of this message; reuse only when redelivering the same message.",
    },
    requestId: {
      type: "string",
      description: "Stable id of one logical operation; reuse it when the same operation is submitted again.",
    },
    type: {
      type: "string",
      enum: ["request", "status", "result", "cancel"],
      description: "request submits work; status/result read the saved snapshot; cancel requests cancellation.",
    },
    payload: PAYLOAD_SCHEMA,
  },
} as const;
export const STATE_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
export const REQUEST_DESCRIPTION =
  "萧何 / Xiao He. Submit a version 1 request and WAIT for its terminal result in this tool call. Use only when a host operation is expected to exceed ~30s, may be retried as the same logical operation (reuse requestId), must outlive a run_code budget end, or several steps must await one execution; otherwise call the original tool directly. messageId is per message; requestId is per logical operation. Control status/result/cancel use an empty payload; their snapshot is read-only. A PTC program end (including run_code budget expiry) only stops waiting: accepted work continues and the same requestId can be retrieved with status/result or cancelled. Diagnostic handler only: test {delayMs:0..30000,fail:boolean}; never use it to perform real work. Acceptance is volatile, not success. No polling or restart resume.";
export const MODE_INSTRUCTIONS =
  "你正在萧何模式中。这不是角色扮演。保留宿主 PTC 的日常工具能力与权限规则。普通编辑、搜索、命令、安装和其他工作使用原工具，不要声称此模式只读。execution_bus 是可选协调入口，只在以下情况使用：预计单次宿主操作超过约 30 秒；同一逻辑操作可能重复提交或需要重试核对（沿用 requestId）；任务需要在 run_code 时间预算结束后继续或取回结果；多个步骤需要等待同一执行。其余情况直接用原工具，不要为简单调用增加总线包装。实际业务 Handler 为 host.read、host.glob、host.grep（只读，可复用终态结果）与 host.edit、host.write、host.pwsh（有副作用，终态结果不可复用）；test 仅用于用户明确要求的诊断，不做真实工作。示例：await tools.execution_bus({protocolVersion:1,messageId:\"<消息编号>\",requestId:\"<逻辑操作编号>\",type:\"request\",payload:{handler:\"host.read\",input:{file_path:\"README.md\"}}})；messageId 每条消息唯一，同一逻辑操作重发沿用 requestId。通过 run_code 调用 await tools.execution_bus(...)，受原有时间预算约束。每会话排队上限 " +
  ADMISSION_DEFAULTS.sessionQueueLimit +
  "，排队超过 " +
  ADMISSION_DEFAULTS.maxQueueWaitMs / 1000 +
  " 秒且未执行会返回 QUEUE_WAIT_TIMEOUT，不自动重试。execution_bus_state 只用于用户明确诊断本会话元数据，不循环查询。请求只提交一次并等待结果，同一逻辑操作重发沿用 requestId。PTC 程序结束或 run_code 时间预算到期时，已受理请求只停止等待、继续执行；用同一 requestId 的 status/result 取回，或用 cancel 取消；用户/会话中断仍会请求取消执行。cancelRequested 不等于已取消，unknown 不代表执行失败，不承诺跨重启恢复。后台命令返回 Job ID 不代表已经完成。";
