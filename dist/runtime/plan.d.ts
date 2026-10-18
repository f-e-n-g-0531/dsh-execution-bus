/** 声明式运行时只允许调用这些宿主工具；新增工具需同时更新幂等性判断。 */
export declare const RUNTIME_TOOLS: readonly ["read", "glob", "grep", "edit", "write", "pwsh"];
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];
export declare const IDEMPOTENT_TOOLS: ReadonlySet<string>;
export interface PlanStep {
    id: string;
    tool: RuntimeTool;
    input: Record<string, unknown>;
    dependsOn: string[];
    /** 仅幂等工具允许 >0；重试次数（不含首次）。 */
    retry: number;
    timeoutMs: number;
}
export interface Plan {
    goal?: string;
    steps: PlanStep[];
    concurrency: number;
}
export declare const RUNTIME_LIMITS: Readonly<{
    steps: 32;
    planBytes: number;
    idChars: 64;
    retry: 3;
    timeoutMinMs: 1000;
    timeoutMaxMs: 600000;
    concurrencyMax: 4;
    goalChars: 500;
    resultBytes: number;
}>;
export declare function parsePlan(raw: unknown): Plan;
