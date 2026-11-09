import type { DependencyContext } from "./dependency-context.js";
import type { ModelWaitStatus } from "./model-wait.js";
/** Trusted host wiring only; bind an already registered/admitted tool to this child. */
export interface WorkerHostOptions {
    dependencyReader?: {
        toolName: string;
        bind(agent: Agent, context: DependencyContext): () => void;
    };
    onModelWait?: (sessionId: string, status: ModelWaitStatus | undefined) => void;
}
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { AcceptanceCriterion, WorkerReport } from "./agent-report.js";
import type { WorkerTrace } from "./agent-trace.js";
export interface AgentInput {
    prompt: string;
    access: "read";
    write_scopes: string[];
    max_steps: number;
    output_format?: "text" | "report";
    acceptance_criteria?: AcceptanceCriterion[];
}
/** Keep the public wire names; never interpret prompt text as authorization. */
export declare function parseAgentInput(raw: unknown): AgentInput;
/** The exact runtime-owned instructions hashed in WorkerTrace and sent to the child. */
export declare function workerInstructions(input: AgentInput): string;
/**
 * Trusted host capability, NOT a DSH rc1 API or model-supplied input.
 * The host must check every live parent policy missing from the child scope,
 * including parent-local hooks/guards, without replaying global or composed
 * preset policies already checked by the child's native invocation pipeline.
 * Return allow only after all supplemental checks allow. Ask/cancel/deny and
 * exceptions fail closed; this adapter must never dispatch tools or prompt.
 * A host unable to guarantee completeness and deduplication must not supply it.
 */
export interface DelegationPolicyAdapter {
    checkParentPolicy(request: {
        readonly parentCall: ToolExecution;
        readonly childCall: ToolExecution;
    }): {
        kind: string;
    } | Promise<{
        kind: string;
    }>;
}
/** Independent, bounded native-tool worker. No parent transcript is seeded. */
export declare function executeAgent(ctx: Context, exec: ToolRunContext, raw: unknown, signal: AbortSignal, onCreated?: (sessionId: string, trace?: WorkerTrace) => void, onTrace?: (sessionId: string, trace: WorkerTrace) => void, delegationPolicy?: DelegationPolicyAdapter, hostOptions?: WorkerHostOptions, context?: DependencyContext): Promise<{
    sessionId: string;
    output: string;
    verification: "not_independently_verified";
    report?: WorkerReport;
    trace: WorkerTrace;
}>;
