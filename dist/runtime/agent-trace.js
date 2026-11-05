import { createHash } from "node:crypto";
/** Version only the runtime-owned role/output contract, not the entire host prompt. */
export const WORKER_PROMPT_VERSION = "xiaohe-worker-v1";
export const WORKER_ROLE_INSTRUCTIONS = "You are a bounded read-only worker, not the Lead. Perform only the supplied task using the native read, glob and grep tools available to you. Do not invoke runtime plans, run_code, shell commands, delegation, writes or permission escalation. Return a concise factual report, distinguish evidence from inference, and disclose any verification not performed. Your output is not independently verified acceptance.";
export function promptHash(text) {
    return createHash("sha256").update(text, "utf8").digest("hex");
}
export function modelRoute(raw) {
    return {
        provider: raw.provider,
        model: raw.model,
        ...(raw.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: raw.reasoningEffort }),
    };
}
export function validWorkerTrace(raw) {
    const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const text = (v) => typeof v === "string" && !!v.trim() && v.length <= 1024;
    const route = (v) => object(v) &&
        Object.keys(v).every((k) => ["provider", "model", "reasoningEffort"].includes(k)) &&
        text(v.provider) &&
        text(v.model) &&
        (v.reasoningEffort === undefined || text(v.reasoningEffort));
    return (object(raw) &&
        Object.keys(raw).every((k) => [
            "promptVersion",
            "promptHash",
            "taskPromptHash",
            "outputFormat",
            "selectedModel",
            "requestModels",
        ].includes(k)) &&
        text(raw.promptVersion) &&
        typeof raw.promptHash === "string" &&
        /^[a-f0-9]{64}$/.test(raw.promptHash) &&
        typeof raw.taskPromptHash === "string" &&
        /^[a-f0-9]{64}$/.test(raw.taskPromptHash) &&
        ["text", "report"].includes(raw.outputFormat) &&
        route(raw.selectedModel) &&
        Array.isArray(raw.requestModels) &&
        raw.requestModels.length <= 64 &&
        raw.requestModels.every(route));
}
