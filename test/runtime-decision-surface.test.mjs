import { test } from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { RUNTIME_DECISION_PARAMETERS, RUNTIME_DECISION_DESCRIPTION } from "../dist/product.js";
import { RUNTIME_OUTPUT_SCHEMAS, runtimePresentationMeta } from "../dist/presentation.js";

test("decision tool schema is strict and bounded; declarations are not approval", () => {
  const input = { runId: "run-test1234", snapshotHash: "a".repeat(64), key: "b".repeat(64), expectedRevision: 0, disposition: "answered", reason: "recorded", answer_ref: "session:answer" };
  assert.deepEqual(validateJsonSchemaValue(RUNTIME_DECISION_PARAMETERS, input), []);
  for (const patch of [{ disposition: "approved" }, { automatic: true }])
    assert.ok(validateJsonSchemaValue(RUNTIME_DECISION_PARAMETERS, { ...input, ...patch }).length);
  // rc.1 schema validator ignores numeric/string bounds; service validation is authoritative.
  assert.equal(RUNTIME_DECISION_PARAMETERS.properties.expectedRevision.maximum, 31);
  assert.equal(RUNTIME_DECISION_PARAMETERS.properties.answer_ref.maxLength, 1000);
  assert.match(RUNTIME_DECISION_DESCRIPTION, /不证明用户批准/);
  assert.match(RUNTIME_DECISION_DESCRIPTION, /不自动执行/);
});

test("decision schema and cards show disposition without private references or false pending alert", () => {
  const summary = { runId: "run-test1234", state: "succeeded", createdAt: 1, updatedAt: 2, durationMs: 1, steps: [],
    attention: { items: [{ key: "b".repeat(64), kind: "decision_required", stepId: "worker", disposition: "answered" }], notification: { key: "c".repeat(64), shouldNotify: false } },
    decisionLedger: { revision: 1, verification: "owner_declared_not_user_approval", items: [{ key: "b".repeat(64), stepId: "worker", status: "answered", recordedAt: 3 }] },
    decisionHistory: [{ revision: 1, snapshotHash: "a".repeat(64), key: "b".repeat(64), disposition: "answered", reason: "PRIVATE_REASON", answerRef: "PRIVATE_REF", at: 3 }] };
  assert.deepEqual(validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_decision, summary), []);
  const card = JSON.stringify(runtimePresentationMeta({}, summary));
  assert.match(card, /已记录答复/);
  assert.doesNotMatch(card, /PRIVATE_REASON|PRIVATE_REF|待 Lead 决策/);
});
