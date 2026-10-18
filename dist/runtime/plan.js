import { ERRORS } from "../error-codes.js";
/** 声明式运行时只允许调用这些宿主工具；新增工具需同时更新幂等性判断。 */
export const RUNTIME_TOOLS = Object.freeze([
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "pwsh",
]);
export const IDEMPOTENT_TOOLS = new Set([
    "read",
    "glob",
    "grep",
]);
export const RUNTIME_LIMITS = Object.freeze({
    steps: 32,
    planBytes: 64 * 1024,
    idChars: 64,
    retry: 3,
    timeoutMinMs: 1000,
    timeoutMaxMs: 600000,
    concurrencyMax: 4,
    goalChars: 500,
    resultBytes: 64 * 1024,
});
const PLAN_KEYS = new Set(["goal", "steps", "concurrency"]);
const STEP_KEYS = new Set([
    "id",
    "tool",
    "input",
    "depends_on",
    "retry",
    "timeout_ms",
]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
function invalid() {
    throw Error(ERRORS.INVALID_PLAN);
}
function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
export function parsePlan(raw) {
    if (!isPlainObject(raw))
        invalid();
    for (const key of Reflect.ownKeys(raw)) {
        if (typeof key !== "string" || !PLAN_KEYS.has(key))
            invalid();
        const descriptor = Object.getOwnPropertyDescriptor(raw, key);
        if (!("value" in descriptor) || !descriptor.enumerable)
            invalid();
    }
    let bytes = 0;
    try {
        bytes = Buffer.byteLength(JSON.stringify(raw));
    }
    catch {
        invalid();
    }
    if (bytes > RUNTIME_LIMITS.planBytes)
        throw Error(ERRORS.PLAN_TOO_LARGE);
    const goal = raw.goal;
    if (goal !== undefined) {
        if (typeof goal !== "string" ||
            goal.length > RUNTIME_LIMITS.goalChars)
            invalid();
    }
    const concurrency = raw.concurrency ?? 2;
    if (typeof concurrency !== "number" ||
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > RUNTIME_LIMITS.concurrencyMax)
        invalid();
    if (!Array.isArray(raw.steps))
        invalid();
    if (raw.steps.length < 1 || raw.steps.length > RUNTIME_LIMITS.steps)
        invalid();
    const ids = new Set();
    const steps = raw.steps.map((value) => {
        const step = parseStep(value);
        if (ids.has(step.id))
            throw Error(ERRORS.PLAN_DUPLICATE_ID);
        ids.add(step.id);
        return step;
    });
    for (const step of steps) {
        for (const dep of step.dependsOn) {
            if (dep === step.id)
                invalid();
            if (!ids.has(dep))
                throw Error(ERRORS.PLAN_UNKNOWN_DEP);
        }
    }
    assertAcyclic(steps);
    return {
        ...(goal === undefined ? {} : { goal: goal }),
        steps,
        concurrency,
    };
}
function parseStep(value) {
    if (!isPlainObject(value))
        invalid();
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !STEP_KEYS.has(key))
            invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!("value" in descriptor) || !descriptor.enumerable)
            invalid();
    }
    const id = value.id;
    if (typeof id !== "string" ||
        !ID_PATTERN.test(id) ||
        id.length > RUNTIME_LIMITS.idChars)
        invalid();
    const tool = value.tool;
    if (typeof tool !== "string" || !RUNTIME_TOOLS.includes(tool))
        throw Error(ERRORS.PLAN_UNKNOWN_TOOL);
    if (!isPlainObject(value.input))
        invalid();
    const dependsOn = value.depends_on ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.length > RUNTIME_LIMITS.steps)
        invalid();
    const deps = [];
    for (const dep of dependsOn) {
        if (typeof dep !== "string" || !ID_PATTERN.test(dep))
            invalid();
        if (deps.includes(dep))
            invalid();
        deps.push(dep);
    }
    const retry = value.retry ?? 0;
    if (typeof retry !== "number" ||
        !Number.isSafeInteger(retry) ||
        retry < 0 ||
        retry > RUNTIME_LIMITS.retry)
        invalid();
    if (retry > 0 && !IDEMPOTENT_TOOLS.has(tool))
        throw Error(ERRORS.PLAN_RETRY_DENIED);
    const timeoutMs = value.timeout_ms ?? 120000;
    if (typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < RUNTIME_LIMITS.timeoutMinMs ||
        timeoutMs > RUNTIME_LIMITS.timeoutMaxMs)
        invalid();
    return {
        id,
        tool: tool,
        input: structuredClone(value.input),
        dependsOn: deps,
        retry,
        timeoutMs,
    };
}
function assertAcyclic(steps) {
    const indegree = new Map();
    const children = new Map();
    for (const step of steps) {
        indegree.set(step.id, step.dependsOn.length);
        for (const dep of step.dependsOn) {
            const list = children.get(dep) ?? [];
            list.push(step.id);
            children.set(dep, list);
        }
    }
    const ready = [...indegree.entries()]
        .filter(([, degree]) => degree === 0)
        .map(([id]) => id);
    let visited = 0;
    while (ready.length) {
        const id = ready.pop();
        visited++;
        for (const child of children.get(id) ?? []) {
            const degree = (indegree.get(child) ?? 0) - 1;
            indegree.set(child, degree);
            if (degree === 0)
                ready.push(child);
        }
    }
    if (visited !== steps.length)
        throw Error(ERRORS.PLAN_CYCLE);
}
