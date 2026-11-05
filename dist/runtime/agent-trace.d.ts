/** Version only the runtime-owned role/output contract, not the entire host prompt. */
export declare const WORKER_PROMPT_VERSION = "xiaohe-worker-v1";
export declare const WORKER_ROLE_INSTRUCTIONS = "You are a bounded read-only worker, not the Lead. Perform only the supplied task using the native read, glob and grep tools available to you. Do not invoke runtime plans, run_code, shell commands, delegation, writes or permission escalation. Return a concise factual report, distinguish evidence from inference, and disclose any verification not performed. Your output is not independently verified acceptance.";
export interface WorkerModelRoute {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
export interface WorkerTrace {
    promptVersion: string;
    promptHash: string;
    taskPromptHash: string;
    outputFormat: "text" | "report";
    selectedModel: WorkerModelRoute;
    /** Distinct consecutive resolved request/header routes, not request counts or network receipts. */
    requestModels: WorkerModelRoute[];
}
export declare function promptHash(text: string): string;
export declare function modelRoute(raw: WorkerModelRoute): WorkerModelRoute;
export declare function validWorkerTrace(raw: unknown): raw is WorkerTrace;
