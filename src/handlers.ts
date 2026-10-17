import { setTimeout } from "node:timers/promises";
import type { Handler } from "./bus.js";
import { ERRORS } from "./error-codes.js";
import { HANDLER_LIMITS } from "./product.js";

/** 宿主工具转发 Handler 工厂：校验后把调用交回宿主工具管线执行。
 *  idempotent 由调用方按工具副作用显式声明；prepare 可补默认参数。 */
export function hostToolHandler(
  toolName: string,
  opts: {
    idempotent: boolean;
    validate(input: Record<string, unknown>): void;
    prepare?(input: Record<string, unknown>): Record<string, unknown>;
  },
): Handler {
  // toolName 只表达意图；实际宿主工具已由宿主层按 handler 名绑定到 capability。
  void toolName;
  return {
    idempotent: opts.idempotent,
    validate: opts.validate,
    async run(input, ctx) {
      if (!ctx.invoke) throw Error(ERRORS.HOST_CAPABILITY_REQUIRED);
      return ctx.invoke(opts.prepare ? opts.prepare(input) : input, ctx.signal);
    },
  };
}

export const testHandler: Handler = {
  idempotent: true,
  validate(input) {
    if (
      Object.keys(input).some((k) => !["delayMs", "fail"].includes(k)) ||
      !Number.isSafeInteger(input.delayMs) ||
      Number(input.delayMs) < 0 ||
      Number(input.delayMs) > HANDLER_LIMITS.diagnosticDelayMs ||
      typeof input.fail !== "boolean"
    )
      throw Error(ERRORS.INVALID_TEST_INPUT);
  },
  async run(input, ctx) {
    for (let i = 1; i <= 5; i++) {
      await setTimeout(Number(input.delayMs) / 5, undefined, {
        signal: ctx.signal,
      });
      ctx.progress(i, i * 20);
    }
    if (input.fail) throw Error(ERRORS.CONTROLLED_FAILURE);
    return { ok: true };
  },
};

function validateRead(input: Record<string, unknown>) {
  if (
    Object.keys(input).some(
      (k) => !["file_path", "offset", "limit"].includes(k),
    ) ||
    typeof input.file_path !== "string" ||
    !input.file_path ||
    input.file_path.length > HANDLER_LIMITS.readPathChars
  )
    throw Error(ERRORS.INVALID_READ_INPUT);
  for (const k of ["offset", "limit"])
    if (
      input[k] !== undefined &&
      (!Number.isSafeInteger(input[k]) || Number(input[k]) < 1)
    )
      throw Error(ERRORS.INVALID_READ_INPUT);
  if (Number(input.limit ?? HANDLER_LIMITS.readLines) > HANDLER_LIMITS.readLines)
    throw Error(ERRORS.READ_LIMIT);
}

function validateEdit(input: Record<string, unknown>) {
  if (
    Object.keys(input).some(
      (k) =>
        !["file_path", "old_string", "new_string", "replace_all"].includes(k),
    ) ||
    typeof input.file_path !== "string" ||
    !input.file_path ||
    input.file_path.length > HANDLER_LIMITS.readPathChars ||
    typeof input.old_string !== "string" ||
    typeof input.new_string !== "string" ||
    (input.replace_all !== undefined && typeof input.replace_all !== "boolean")
  )
    throw Error(ERRORS.INVALID_EDIT_INPUT);
}

/** 读取：无副作用，幂等，终态结果可复用。 */
export const readHandler: Handler = hostToolHandler("read", {
  idempotent: true,
  validate: validateRead,
  prepare: (input) => ({
    ...input,
    limit: input.limit ?? HANDLER_LIMITS.readLines,
  }),
});

function validateGlob(input: Record<string, unknown>) {
  if (
    Object.keys(input).some((k) => !["pattern", "path"].includes(k)) ||
    typeof input.pattern !== "string" ||
    input.pattern.trim().length === 0 ||
    (input.path !== undefined &&
      (typeof input.path !== "string" || input.path.trim().length === 0))
  )
    throw Error(ERRORS.INVALID_GLOB_INPUT);
}

/** 文件名搜索：只读，幂等，终态结果可复用；搜索基数由宿主工具限制。 */
export const globHandler: Handler = hostToolHandler("glob", {
  idempotent: true,
  validate: validateGlob,
});

function validateGrep(input: Record<string, unknown>) {
  if (
    Object.keys(input).some(
      (k) => !["pattern", "path", "include"].includes(k),
    ) ||
    typeof input.pattern !== "string" ||
    input.pattern.length === 0 ||
    (input.path !== undefined &&
      (typeof input.path !== "string" || input.path.trim().length === 0))
  )
    throw Error(ERRORS.INVALID_GREP_INPUT);
  if (input.include === undefined) return;
  const include = input.include;
  if (typeof include !== "string" || include.trim().length === 0)
    throw Error(ERRORS.INVALID_GREP_INPUT);
  // 与宿主 grep 契约一致：只接受单个正向 glob，不支持取反或顶层逗号列表。
  if (include.startsWith("!")) throw Error(ERRORS.INVALID_GREP_INPUT);
  let braceDepth = 0;
  for (const char of include) {
    if (char === "{") braceDepth++;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "," && braceDepth === 0)
      throw Error(ERRORS.INVALID_GREP_INPUT);
  }
}

/** 内容搜索：只读，幂等，终态结果可复用；匹配上限由宿主工具限制。 */
export const grepHandler: Handler = hostToolHandler("grep", {
  idempotent: true,
  validate: validateGrep,
});

function validateWrite(input: Record<string, unknown>) {
  if (
    Object.keys(input).some((k) => !["file_path", "content"].includes(k)) ||
    typeof input.file_path !== "string" ||
    !input.file_path ||
    input.file_path.length > HANDLER_LIMITS.readPathChars ||
    typeof input.content !== "string"
  )
    throw Error(ERRORS.INVALID_WRITE_INPUT);
}

/** 写入：有副作用，非幂等，终态结果不可复用。 */
export const writeHandler: Handler = hostToolHandler("write", {
  idempotent: false,
  validate: validateWrite,
});

/** 编辑：有副作用，非幂等，终态结果不可复用。 */
export const editHandler: Handler = hostToolHandler("edit", {
  idempotent: false,
  validate: validateEdit,
});

/** 与宿主 pwsh 工具一致的提权目标；沙箱组合未提供提权面时由宿主拒绝。 */
const PWSH_ESCALATION_TARGETS = Object.freeze([
  "workspace-write",
  "danger-full-access",
]);

function validatePwsh(input: Record<string, unknown>) {
  if (
    Object.keys(input).some(
      (k) =>
        ![
          "description",
          "command",
          "timeoutMs",
          "workdir",
          "run_in_background",
          "sandbox_permissions",
          "justification",
        ].includes(k),
    ) ||
    typeof input.command !== "string" ||
    input.command.trim().length === 0 ||
    typeof input.description !== "string" ||
    input.description.trim().length === 0 ||
    (input.timeoutMs !== undefined &&
      (!Number.isFinite(input.timeoutMs) || Number(input.timeoutMs) <= 0)) ||
    (input.workdir !== undefined && typeof input.workdir !== "string") ||
    (input.run_in_background !== undefined &&
      typeof input.run_in_background !== "boolean")
  )
    throw Error(ERRORS.INVALID_PWSH_INPUT);
  const permissions = input.sandbox_permissions,
    justification = input.justification;
  if (
    (permissions !== undefined && justification === undefined) ||
    (justification !== undefined && permissions === undefined) ||
    (permissions !== undefined &&
      (typeof permissions !== "string" ||
        !PWSH_ESCALATION_TARGETS.includes(permissions))) ||
    (justification !== undefined &&
      (typeof justification !== "string" ||
        justification.trim().length === 0))
  )
    throw Error(ERRORS.INVALID_PWSH_INPUT);
}

/** 命令执行：有副作用，非幂等，终态结果不可复用；后台模式返回 Job ID 不等于完成。 */
export const pwshHandler: Handler = hostToolHandler("pwsh", {
  idempotent: false,
  validate: validatePwsh,
});
