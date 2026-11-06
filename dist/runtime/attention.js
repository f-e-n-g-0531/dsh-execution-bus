import { createHash } from "node:crypto";
import { runAcceptance, runRecovery } from "./insights.js";
import { ownerReview } from "./review.js";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/**
 * Pure, owner-side advice: Worker decisions are self-reported, never verified.
 * Keys describe content, not delivery, acknowledgement, or cross-session deduplication.
 * No private report text, paths, errors, or plan inputs are projected.
 */
export function runAttention(run, settled) {
    const recovery = runRecovery(run, settled);
    const acceptance = runAcceptance(run);
    const items = [];
    const seen = new Set();
    const add = (kind, stepId, resultHash) => {
        const content = {
            kind,
            ...(stepId === undefined ? {} : { stepId }),
            ...(resultHash === undefined ? {} : { resultHash }),
        };
        const key = digest({ runId: run.runId, ...content });
        if (!seen.has(key)) {
            seen.add(key);
            items.push({ key, ...content });
        }
    };
    // Recovery owns uncertainty/failure precedence; cleanup is not external completion.
    if (recovery.nextAction === "inspect_external_state")
        add("inspect_external_state");
    else if (recovery.nextAction === "inspect_failure")
        add("inspect_failure");
    else if (recovery.nextAction === "resume_read_only")
        add("resume_read_only");
    const workers = [...acceptance.workers].sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
    for (const worker of workers) {
        if (worker.decisionRequired)
            add("decision_required", worker.stepId, worker.resultHash);
    }
    const results = [];
    let complete = true;
    const steps = [...run.steps].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const step of steps) {
        if (step.state !== "succeeded") {
            complete = false;
            continue;
        }
        const stored = Object.hasOwn(run.results, step.id)
            ? run.results[step.id]
            : undefined;
        let resultHash;
        if (stored && !stored.truncated && Object.hasOwn(stored, "value")) {
            try {
                const text = JSON.stringify(stored.value);
                if (text !== undefined)
                    resultHash = createHash("sha256").update(text).digest("hex");
            }
            catch {
                // Non-serializable values cannot constitute a complete saved result.
            }
        }
        if (resultHash === undefined) {
            complete = false;
            add("result_unavailable", step.id);
        }
        else {
            results.push({ stepId: step.id, resultHash });
        }
    }
    // A single run-level review also covers ordinary-tool results, not just Workers.
    if (run.state === "succeeded" &&
        recovery.nextAction === "review_results" &&
        complete &&
        items.length === 0 &&
        ownerReview(run).status !== "accepted")
        add("review_results", undefined, digest(results));
    return {
        items,
        notification: {
            key: digest({ runId: run.runId, items }),
            shouldNotify: items.length > 0,
        },
    };
}
