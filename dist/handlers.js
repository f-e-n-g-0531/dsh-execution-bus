import { setTimeout } from "node:timers/promises";
import { ERRORS } from "./error-codes.js";
import { HANDLER_LIMITS } from "./product.js";
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
export const readHandler = {
    idempotent: true,
    validate(input) {
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
    },
    async run(input, ctx) {
        if (!ctx.invoke)
            throw Error(ERRORS.HOST_CAPABILITY_REQUIRED);
        return ctx.invoke({ ...input, limit: input.limit ?? HANDLER_LIMITS.readLines }, ctx.signal);
    },
};
