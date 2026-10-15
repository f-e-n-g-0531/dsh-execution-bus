import { setTimeout } from "node:timers/promises";
export const testHandler = {
    validate(input) {
        if (Object.keys(input).some((k) => !["delayMs", "fail"].includes(k)) ||
            !Number.isSafeInteger(input.delayMs) ||
            Number(input.delayMs) < 0 ||
            Number(input.delayMs) > 30000 ||
            typeof input.fail !== "boolean")
            throw Error("INVALID_TEST_INPUT");
    },
    async run(input, ctx) {
        for (let i = 1; i <= 5; i++) {
            await setTimeout(Number(input.delayMs) / 5, undefined, {
                signal: ctx.signal,
            });
            ctx.progress(i, i * 20);
        }
        if (input.fail)
            throw Error("CONTROLLED_FAILURE");
        return { ok: true };
    },
};
export const readHandler = {
    validate(input) {
        if (Object.keys(input).some((k) => !["file_path", "offset", "limit"].includes(k)) ||
            typeof input.file_path !== "string" ||
            !input.file_path ||
            input.file_path.length > 2048)
            throw Error("INVALID_READ_INPUT");
        for (const k of ["offset", "limit"])
            if (input[k] !== undefined &&
                (!Number.isSafeInteger(input[k]) || Number(input[k]) < 1))
                throw Error("INVALID_READ_INPUT");
        if (Number(input.limit ?? 100) > 100)
            throw Error("READ_LIMIT");
    },
    async run(input, ctx) {
        if (!ctx.invoke)
            throw Error("HOST_CAPABILITY_REQUIRED");
        return ctx.invoke({ ...input, limit: input.limit ?? 100 }, ctx.signal);
    },
};
