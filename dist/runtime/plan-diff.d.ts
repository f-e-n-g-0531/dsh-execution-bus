import type { Plan } from "./plan.js";
export interface PlanChanges {
    addedSteps: string[];
    removedSteps: string[];
    changedSteps: Array<{
        id: string;
        fields: Array<"tool" | "input" | "dependsOn" | "retry" | "timeoutMs">;
    }>;
    concurrencyChanged: boolean;
    goalChanged: boolean;
    provenanceChanged: boolean;
    handoffChanged: boolean;
}
/**
 * Compare parsed plans by step identity, exposing field names only, never input
 * values or digests. Task/run linkage is history metadata, not plan semantics.
 * Callers supply valid Plans; this function does not validate or normalize them.
 */
export declare function comparePlans(before: Plan, after: Plan): PlanChanges;
