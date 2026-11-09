import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePlans } from "../dist/runtime/plan-diff.js";

const step = (over = {}) => ({
  id: "s1", tool: "read", input: { file_path: "example.txt" },
  dependsOn: [], retry: 0, timeoutMs: 120000, ...over,
});
const plan = (over = {}) => ({ steps: [step()], concurrency: 2, ...over });
const unchanged = () => ({
  addedSteps: [], removedSteps: [], changedSteps: [],
  concurrencyChanged: false, goalChanged: false, provenanceChanged: false, handoffChanged: false,
});

test("identical plans and equivalent clones have no changes", () => {
  const before = plan();
  assert.deepEqual(comparePlans(before, before), unchanged());
  assert.deepEqual(comparePlans(before, structuredClone(before)), unchanged());
  assert.deepEqual(comparePlans(plan({ steps: [] }), plan({ steps: [] })), unchanged());
});

for (const [field, value] of [
  ["tool", "grep"], ["input", { file_path: "other.txt" }],
  ["dependsOn", ["root"]], ["retry", 2], ["timeoutMs", 3000],
]) {
  test(`reports only changed step field: ${field}`, () => {
    const roots = [step({ id: "root" })];
    const before = plan({ steps: [...roots, step()] });
    const after = plan({ steps: [...roots, step({ [field]: value })] });
    assert.deepEqual(comparePlans(before, after), {
      ...unchanged(), changedSteps: [{ id: "s1", fields: [field] }],
    });
  });
}

test("reports all changed fields in stable declared order", () => {
  const before = plan({ steps: [step({ id: "root" }), step()] });
  const after = plan({ steps: [step({ id: "root" }), step({
    tool: "grep", input: { pattern: "changed" }, dependsOn: ["root"],
    retry: 1, timeoutMs: 3000,
  })] });
  assert.deepEqual(comparePlans(before, after), {
    ...unchanged(), changedSteps: [{
      id: "s1", fields: ["tool", "input", "dependsOn", "retry", "timeoutMs"],
    }],
  });
});

test("nested JSON object key order is ignored, including objects inside arrays", () => {
  const before = plan({ steps: [step({ input: {
    outer: { a: 1, b: { c: null, d: [true, { x: 2, y: "v" }] } }, empty: {},
  } })] });
  const after = plan({ steps: [step({ input: {
    empty: {}, outer: { b: { d: [true, { y: "v", x: 2 }], c: null }, a: 1 },
  } })] });
  assert.deepEqual(comparePlans(before, after), unchanged());
});

for (const [left, right] of [
  [null, []], [null, {}], [[], {}], [[], [null]],
  [[1, 2], [2, 1]], [[null, { a: [1, 2] }], [null, { a: [2, 1] }]],
  [{ a: null }, {}], [{ a: 1 }, { a: "1" }],
  [{ a: false }, { a: 0 }], [{ a: 1 }, { b: 1 }],
]) {
  test(`JSON value differences remain visible: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`, () => {
    assert.deepEqual(comparePlans(
      plan({ steps: [step({ input: { value: left } })] }),
      plan({ steps: [step({ input: { value: right } })] }),
    ), { ...unchanged(), changedSteps: [{ id: "s1", fields: ["input"] }] });
  });
}

test("dependency order and step order are not semantic changes", () => {
  const before = plan({ steps: [step({ id: "b" }), step({ id: "a" }),
    step({ dependsOn: ["b", "a"] })] });
  const after = plan({ steps: [step({ dependsOn: ["a", "b"] }),
    step({ id: "a" }), step({ id: "b" })] });
  assert.deepEqual(comparePlans(before, after), unchanged());
});

test("dependency comparison uses set membership, not multiplicity", () => {
  const before = plan({ steps: [step({ dependsOn: ["a", "b", "a"] })] });
  const after = plan({ steps: [step({ dependsOn: ["b", "a"] })] });
  assert.deepEqual(comparePlans(before, after), unchanged());
});

test("adds, removes, and changes are independently sorted by ID", () => {
  const before = plan({ steps: ["zRemoved", "zChanged", "aRemoved", "aChanged"].map((id) => step({ id })) });
  const after = plan({ steps: [
    step({ id: "zAdded" }), step({ id: "zChanged", retry: 1 }),
    step({ id: "aAdded" }), step({ id: "aChanged", timeoutMs: 4000 }),
  ] });
  assert.deepEqual(comparePlans(before, after), {
    ...unchanged(), addedSteps: ["aAdded", "zAdded"], removedSteps: ["aRemoved", "zRemoved"],
    changedSteps: [{ id: "aChanged", fields: ["timeoutMs"] }, { id: "zChanged", fields: ["retry"] }],
  });
});

test("renaming a step is removal plus addition, not a changed step", () => {
  assert.deepEqual(comparePlans(plan(), plan({ steps: [step({ id: "renamed" })] })), {
    ...unchanged(), addedSteps: ["renamed"], removedSteps: ["s1"],
  });
});

for (const [field, value, flag] of [
  ["concurrency", 3, "concurrencyChanged"], ["goal", "new goal", "goalChanged"],
  ["provenance", { request_ref: "request-2" }, "provenanceChanged"],
  ["handoff", { summary: "PRIVATE_HANDOFF" }, "handoffChanged"],
]) {
  test(`reports independent plan metadata flag: ${flag}`, () => {
    const before = plan();
    const after = plan({ [field]: value });
    const expected = { ...unchanged(), [flag]: true };
    assert.deepEqual(comparePlans(before, after), expected);
    assert.deepEqual(comparePlans(after, before), expected);
  });
}

test("goal edits and all provenance fields are compared semantically", () => {
  const before = plan({ goal: "old", provenance: {
    request_ref: "r1", scope_summary: "scope", context_refs: ["a", "b"],
  } });
  const reordered = plan({ goal: "old", provenance: {
    context_refs: ["a", "b"], scope_summary: "scope", request_ref: "r1",
  } });
  assert.deepEqual(comparePlans(before, reordered), unchanged());
  for (const patch of [{ request_ref: "r2" }, { scope_summary: "other" }, { context_refs: ["b", "a"] }]) {
    assert.deepEqual(comparePlans(before, plan({ goal: "new", provenance: { ...before.provenance, ...patch } })), {
      ...unchanged(), goalChanged: true, provenanceChanged: true,
    });
  }
});

test("task and previous-run history links are outside the diff contract", () => {
  assert.deepEqual(comparePlans(
    plan({ taskId: "old-task", previousRunId: "old-run" }),
    plan({ taskId: "new-task", previousRunId: "new-run" }),
  ), unchanged());
});

test("results contain only IDs, field names, and flags, never input values or hashes", () => {
  const before = plan({ steps: [step({ input: { secret: "PRIVATE_BEFORE", nested: ["SECRET_A"] } })] });
  const after = plan({ steps: [step({ input: { secret: "PRIVATE_AFTER", nested: ["SECRET_B"] } })] });
  const changes = comparePlans(before, after);
  assert.deepEqual(changes, { ...unchanged(), changedSteps: [{ id: "s1", fields: ["input"] }] });
  assert.doesNotMatch(JSON.stringify(changes), /PRIVATE|SECRET|hash|digest|secret|nested/);
});

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test("does not modify frozen parameters and returns fresh detached results", () => {
  const before = plan({ steps: [step({ id: "z", input: { nested: [{ b: 2, a: 1 }] } }), step({ id: "a" })] });
  const after = plan({ steps: [step({ id: "z", retry: 1 }), step({ id: "new" })] });
  const beforeSnapshot = structuredClone(before);
  const afterSnapshot = structuredClone(after);
  deepFreeze(before);
  deepFreeze(after);
  const first = comparePlans(before, after);
  const second = comparePlans(before, after);
  assert.deepEqual(first, second);
  first.addedSteps.push("injected");
  first.removedSteps.reverse();
  first.changedSteps[0].fields.push("tool");
  first.changedSteps[0].id = "mutated";
  assert.deepEqual(comparePlans(before, after), second);
  assert.deepEqual(before, beforeSnapshot);
  assert.deepEqual(after, afterSnapshot);
});
