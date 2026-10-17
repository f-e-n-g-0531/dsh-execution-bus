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
export const REQUEST_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["protocolVersion", "messageId", "requestId", "type", "payload"],
  properties: {
    protocolVersion: { type: "integer", const: 1 },
    messageId: { type: "string" },
    requestId: { type: "string" },
    type: { type: "string", enum: ["request", "status", "result", "cancel"] },
    payload: { type: "object" },
  },
} as const;
export const STATE_PARAMETERS = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;
export const REQUEST_DESCRIPTION =
  "萧何 / Xiao He. Submit a version 1 request and WAIT for its terminal result in this tool call. Reuse requestId only for the same logical operation. Business handler: host.read {file_path,offset?,limit?<=100}. Diagnostic handler only: test {delayMs:0..30000,fail:boolean}; never use it to perform real work. Control status/result/cancel use empty payload. Acceptance is volatile, not success. No polling or restart resume.";
export const MODE_INSTRUCTIONS =
  "你正在萧何模式中。这不是角色扮演。保留宿主 PTC 的日常工具能力与权限规则。普通编辑、搜索、命令、安装和其他工作使用原工具，不要声称此模式只读。execution_bus 是可选协调入口，实际业务 Handler 只有 host.read；test 仅用于用户明确要求的诊断，不做真实工作，不要强制所有任务走总线。通过 run_code 调用 await tools.execution_bus(...)，受原有时间预算约束。每会话排队上限 " +
  ADMISSION_DEFAULTS.sessionQueueLimit +
  "，排队超过 " +
  ADMISSION_DEFAULTS.maxQueueWaitMs / 1000 +
  " 秒且未执行会返回 QUEUE_WAIT_TIMEOUT，不自动重试。execution_bus_state 只用于用户明确诊断本会话元数据，不循环查询。请求只提交一次并等待结果，同一逻辑操作重发沿用 requestId。cancelRequested 不等于已取消，unknown 不代表执行失败，不承诺跨重启恢复。后台命令返回 Job ID 不代表已经完成。";
