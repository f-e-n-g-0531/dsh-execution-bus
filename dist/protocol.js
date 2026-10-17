import { assertJson } from "./json.js";
import { ERRORS } from "./error-codes.js";
import { LIMITS } from "./limits.js";
export function object(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw Error(ERRORS.INVALID_OBJECT);
    return v;
}
/** 规范排序后的稳定摘要，只用于同 requestId 的冲突比较，不用于跨请求去重。 */
export function canonical(v) {
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map(canonical).join(",") + "]";
    return ("{" +
        Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) +
            ":" +
            canonical(v[k]))
            .join(",") +
        "}");
}
export function parse(raw) {
    assertJson(raw);
    const m = object(raw);
    if (Object.keys(m).some((k) => ![
        "protocolVersion",
        "messageId",
        "requestId",
        "type",
        "payload",
    ].includes(k)))
        throw Error(ERRORS.UNKNOWN_FIELD);
    if (m.protocolVersion !== 1)
        throw Error(ERRORS.UNSUPPORTED_VERSION);
    for (const k of ["messageId", "requestId"])
        if (typeof m[k] !== "string" || !LIMITS.idPattern.test(m[k]))
            throw Error(ERRORS.INVALID_ID);
    if (!["request", "status", "result", "cancel"].includes(m.type))
        throw Error(ERRORS.UNSUPPORTED_TYPE);
    object(m.payload);
    if (Buffer.byteLength(JSON.stringify(m)) > LIMITS.messageMaxBytes)
        throw Error(ERRORS.MESSAGE_TOO_LARGE);
    return structuredClone(m);
}
export function freezeJson(value) {
    if (value && typeof value === "object") {
        for (const child of Object.values(value))
            freezeJson(child);
        Object.freeze(value);
    }
    return value;
}
