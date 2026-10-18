import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../dist/runtime/plan.js";

const step = (over = {}) => ({
  id: "s1",
  tool: "read",
  input: { file_path: "README.md" },
  ...over,
});

test("合法计划解析：依赖、重试、并发与 goal", () => {
  const plan = parsePlan({
    goal: "读取并汇总",
    concurrency: 3,
    steps: [
      step({ id: "read1" }),
      step({ id: "read2", input: { file_path: "package.json" } }),
      step({ id: "merge", tool: "pwsh", input: { description: "d", command: "echo ok" }, depends_on: ["read1", "read2"] }),
      step({ id: "retryRead", retry: 2 }),
    ],
  });
  assert.equal(plan.goal, "读取并汇总");
  assert.equal(plan.concurrency, 3);
  assert.deepEqual(plan.steps[2].dependsOn, ["read1", "read2"]);
  assert.equal(plan.steps[3].retry, 2);
  assert.equal(plan.steps[0].timeoutMs, 120000);
});

test("计划非法形状与限制被拒绝", () => {
  assert.throws(() => parsePlan(null), /INVALID_PLAN/);
  assert.throws(() => parsePlan({ steps: [] }), /INVALID_PLAN/);
  assert.throws(() => parsePlan({ steps: [step(), step()] }), /PLAN_DUPLICATE_ID/);
  assert.throws(() => parsePlan({ steps: [step({ depends_on: ["nope"] })] }), /PLAN_UNKNOWN_DEP/);
  assert.throws(
    () => parsePlan({ steps: [step({ id: "a", depends_on: ["b"] }), step({ id: "b", depends_on: ["a"] })] }),
    /PLAN_CYCLE/,
  );
  assert.throws(() => parsePlan({ steps: [step({ tool: "host.read" })] }), /PLAN_UNKNOWN_TOOL/);
  assert.throws(
    () => parsePlan({ steps: [step({ tool: "edit", input: { file_path: "x", old_string: "a", new_string: "b" }, retry: 1 })] }),
    /PLAN_RETRY_DENIED/,
  );
  assert.throws(() => parsePlan({ steps: [step({ id: "bad id!" })] }), /INVALID_PLAN/);
  assert.throws(() => parsePlan({ steps: [step({ timeout_ms: 10 })] }), /INVALID_PLAN/);
  const tooMany = Array.from({ length: 33 }, (_, i) => step({ id: "s" + i }));
  assert.throws(() => parsePlan({ steps: tooMany }), /INVALID_PLAN/);
  assert.throws(
    () => parsePlan({ steps: [step({ input: { file_path: "x".repeat(70 * 1024) } })] }),
    /PLAN_TOO_LARGE/,
  );
  assert.throws(() => parsePlan({ steps: [step()], extra: 1 }), /INVALID_PLAN/);
});
