/** Compare JSON data without making object insertion order significant. */
function equalJson(left, right) {
    if (left === right)
        return true;
    if (left === null || right === null)
        return false;
    if (typeof left !== "object" || typeof right !== "object")
        return false;
    if (Array.isArray(left) || Array.isArray(right)) {
        return (Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => equalJson(value, right[index])));
    }
    const leftObject = left;
    const rightObject = right;
    const keys = Object.keys(leftObject);
    return (keys.length === Object.keys(rightObject).length &&
        keys.every((key) => Object.hasOwn(rightObject, key) &&
            equalJson(leftObject[key], rightObject[key])));
}
function equalDependencies(left, right) {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return leftSet.size === rightSet.size && [...leftSet].every((id) => rightSet.has(id));
}
/**
 * Compare parsed plans by step identity, exposing field names only, never input
 * values or digests. Task/run linkage is history metadata, not plan semantics.
 * Callers supply valid Plans; this function does not validate or normalize them.
 */
export function comparePlans(before, after) {
    const beforeSteps = new Map(before.steps.map((step) => [step.id, step]));
    const afterSteps = new Map(after.steps.map((step) => [step.id, step]));
    const addedSteps = [...afterSteps.keys()].filter((id) => !beforeSteps.has(id)).sort();
    const removedSteps = [...beforeSteps.keys()].filter((id) => !afterSteps.has(id)).sort();
    const changedSteps = [];
    for (const id of [...beforeSteps.keys()].sort()) {
        const previous = beforeSteps.get(id);
        const current = afterSteps.get(id);
        if (!current)
            continue;
        const fields = [];
        if (previous.tool !== current.tool)
            fields.push("tool");
        if (!equalJson(previous.input, current.input))
            fields.push("input");
        if (!equalDependencies(previous.dependsOn, current.dependsOn))
            fields.push("dependsOn");
        if (previous.retry !== current.retry)
            fields.push("retry");
        if (previous.timeoutMs !== current.timeoutMs)
            fields.push("timeoutMs");
        if (fields.length > 0)
            changedSteps.push({ id, fields });
    }
    return {
        addedSteps,
        removedSteps,
        changedSteps,
        concurrencyChanged: before.concurrency !== after.concurrency,
        goalChanged: before.goal !== after.goal,
        provenanceChanged: !equalJson(before.provenance, after.provenance),
        handoffChanged: !equalJson(before.handoff, after.handoff),
    };
}
