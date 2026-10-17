import { setTimeout } from "node:timers/promises";
import { ERRORS } from "./error-codes.js";
import { HANDLER_LIMITS } from "./product.js";
/** 宿主工具转发 Handler 工厂：校验后把调用交回宿主工具管线执行。
 *  idempotent 由调用方按工具副作用显式声明；prepare 可补默认参数。 */
export function hostToolHandler(toolName, opts) {
    // toolName 只表达意图；实际宿主工具已由宿主层按 handler 名绑定到 capability。
    void toolName;
    return {
        idempotent: opts.idempotent,
        validate: opts.validate,
        async run(input, ctx) {
            if (!ctx.invoke)
                throw Error(ERRORS.HOST_CAPABILITY_REQUIRED);
            return ctx.invoke(opts.prepare ? opts.prepare(input) : input, ctx.signal);
        },
    };
}
export const testHandler = {
    idempotent: true,
    validate(input) {
        if (Object.keys(input).some((k) => !["delayMs", "fail"].includes(k)) ||
            !Number.isSafeInteger(input.delayMs) ||
            Number(input.delayMs) < 0 ||
            Number(input.delayMs) > HANDLER_LIMITS.diagnosticDelayMs ||
            typeof input.fail !== "boolean")
            throw Error(ERRORS.INVALID_TEST_INPUT);
    },
    async run(input, ctx) {
        for (let i = 1; i <= 5; i++) {
            await setTimeout(Number(input.delayMs) / 5, undefined, {
                signal: ctx.signal,
            });
            ctx.progress(i, i * 20);
        }
        if (input.fail)
            throw Error(ERRORS.CONTROLLED_FAILURE);
        return { ok: true };
    },
};
function validateRead(input) {
    if (Object.keys(input).some((k) => !["file_path", "offset", "limit"].includes(k)) ||
        typeof input.file_path !== "string" ||
        !input.file_path ||
        input.file_path.length > HANDLER_LIMITS.readPathChars)
        throw Error(ERRORS.INVALID_READ_INPUT);
    for (const k of ["offset", "limit"])
        if (input[k] !== undefined &&
            (!Number.isSafeInteger(input[k]) || Number(input[k]) < 1))
            throw Error(ERRORS.INVALID_READ_INPUT);
    if (Number(input.limit ?? HANDLER_LIMITS.readLines) > HANDLER_LIMITS.readLines)
        throw Error(ERRORS.READ_LIMIT);
}
function validateEdit(input) {
    if (Object.keys(input).some((k) => !["file_path", "old_string", "new_string", "replace_all"].includes(k)) ||
        typeof input.file_path !== "string" ||
        !input.file_path ||
        input.file_path.length > HANDLER_LIMITS.readPathChars ||
        typeof input.old_string !== "string" ||
        typeof input.new_string !== "string" ||
        (input.replace_all !== undefined && typeof input.replace_all !== "boolean"))
        throw Error(ERRORS.INVALID_EDIT_INPUT);
}
/** 读取：无副作用，幂等，终态结果可复用。 */
export const readHandler = hostToolHandler("read", {
    idempotent: true,
    validate: validateRead,
    prepare: (input) => ({
        ...input,
        limit: input.limit ?? HANDLER_LIMITS.readLines,
    }),
});
function validateWrite(input) {
    if (Object.keys(input).some((k) => !["file_path", "content"].includes(k)) ||
        typeof input.file_path !== "string" ||
        !input.file_path ||
        input.file_path.length > HANDLER_LIMITS.readPathChars ||
        typeof input.content !== "string")
        throw Error(ERRORS.INVALID_WRITE_INPUT);
}
/** 写入：有副作用，非幂等，终态结果不可复用。 */
export const writeHandler = hostToolHandler("write", {
    idempotent: false,
    validate: validateWrite,
});
/** 编辑：有副作用，非幂等，终态结果不可复用。 */
export const editHandler = hostToolHandler("edit", {
    idempotent: false,
    validate: validateEdit,
});
