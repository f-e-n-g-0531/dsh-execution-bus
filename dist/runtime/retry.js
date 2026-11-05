export const MAX_RETRIES = 3;
const PERMISSION = new Set([
    "EACCES",
    "EPERM",
    "PERMISSION_DENIED",
    "ACCESS_DENIED",
    "APPROVAL_DENIED",
    "SANDBOX_DENIED",
    "FS_PERMISSION_DENIED",
    "FS_SANDBOX_DENIED",
]);
const INVALID = new Set([
    "EINVAL",
    "INVALID_ARGUMENT",
    "INVALID_INPUT",
    "INVALID_REQUEST",
    "INVALID_ARGS",
    "INVALID_TOOL_OUTPUT",
]);
const NOT_FOUND = new Set([
    "ENOENT",
    "ENOTDIR",
    "NOT_FOUND",
    "RUNTIME_NOT_FOUND",
    "UNKNOWN_TOOL",
    "FS_NOT_FOUND",
    "FS_NOT_DIRECTORY",
]);
const STOPPED = new Set([
    "ABORTED",
    "ABORTED_BEFORE_DISPATCH",
    "FS_ABORTED",
    "RUNTIME_CANCELLED",
    "RUNTIME_STEP_TIMEOUT",
    "RUNTIME_STORAGE_FAILED",
]);
const TRANSIENT = new Set([
    "EAGAIN",
    "EBUSY",
    "ETIMEDOUT",
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ENETDOWN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EAI_AGAIN",
]);
/** Only own data properties are accepted; host accessors must not run during policy checks. */
function field(error, key) {
    if (!error || typeof error !== "object")
        return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(error, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
    }
    catch {
        return undefined;
    }
}
export function classifyRetryError(error) {
    const category = field(error, "category");
    const codes = [field(error, "code"), field(error, "errno")];
    const statuses = [field(error, "status"), field(error, "statusCode")];
    const hasCode = (set) => codes.some((code) => typeof code === "string" && set.has(code));
    // Permanent evidence wins even if a conflicting transient hint is also present.
    if (category === "permission" ||
        hasCode(PERMISSION) ||
        statuses.some((s) => s === 401 || s === 403))
        return { category: "permission", retryable: false };
    if (category === "invalid" ||
        hasCode(INVALID) ||
        statuses.some((s) => s === 400 || s === 422))
        return { category: "invalid", retryable: false };
    if (category === "not_found" ||
        category === "notfound" ||
        hasCode(NOT_FOUND) ||
        statuses.some((s) => s === 404 || s === 410))
        return { category: "not_found", retryable: false };
    const knownStatus = statuses.filter((s) => typeof s === "number" && Number.isInteger(s) && s >= 400 && s <= 599);
    const transientStatus = (s) => s === 408 || s === 429 || s >= 500;
    if (category === "deterministic" ||
        hasCode(STOPPED) ||
        knownStatus.some((s) => !transientStatus(s)))
        return { category: "deterministic", retryable: false };
    if (hasCode(TRANSIENT) || knownStatus.some(transientStatus))
        return { category: "transient", retryable: true };
    // Preserve the pre-policy generic Error retry contract. Unknown structured hints
    // are not evidence of a transient failure and therefore fail closed.
    if (category !== undefined ||
        codes.some((v) => v !== undefined) ||
        statuses.some((v) => v !== undefined))
        return { category: "deterministic", retryable: false };
    return { category: "legacy_unknown", retryable: true };
}
/** 1-based retry ordinal, independent of wall clock; at most 700ms total delay. */
export function retryDelayMs(retry) {
    if (!Number.isSafeInteger(retry) || retry < 1 || retry > MAX_RETRIES)
        return 0;
    return 100 * 2 ** (retry - 1);
}
/** Aborting a backoff clears its timer/listener and never starts a new attempt. */
export function waitForRetry(ms, signal) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, Math.min(400, Math.max(0, ms)));
        signal.addEventListener("abort", finish, { once: true });
    });
}
