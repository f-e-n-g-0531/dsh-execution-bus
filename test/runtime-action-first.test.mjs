import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimePresentationMeta } from "../dist/presentation.js";
const item = (kind, extra = {}) => ({ key: kind, kind, ...extra });
const run = (runId, items = []) => ({
  runId,
  state: "running",
  attention: { items },
});
const requests = (text) =>
  text
    .split("\n")
    .filter((l) => l.startsWith("只读定位："))
    .map((l) => JSON.parse(l.slice("只读定位：runtime_result(".length, -1)));
test("current-page action partition is stable and pure", () => {
  const value = {
    runs: [
      run("quiet-new"),
      run("action-new", [item("review_results")]),
      run("quiet-old"),
      run("action-old", [item("inspect_external_state")]),
    ],
  };
  value.runs[0].waiting = { steps: [{ stepId: "s", reason: "dependency" }] };
  const before = structuredClone(value);
  const text = runtimePresentationMeta({}, value).text;
  assert.match(text, /本页运行.*不代表全部待办/);
  const positions = ["action-new", "action-old", "quiet-new", "quiet-old"].map(
    (id) => text.indexOf(id + " ·"),
  );
  assert.ok(
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
  );
  assert.deepEqual(value, before);
  assert.equal(
    runtimePresentationMeta({}, { runs: [] }).text,
    "本会话暂无运行。",
  );
});
test("uncertainty and actions precede progress and cleanup", () => {
  const value = {
    ...run("ordered", [
      item("review_results"),
      item("decision_required"),
      item("inspect_failure"),
      item("inspect_external_state"),
    ]),
    executionSettled: false,
    progress: {
      total: 1,
      succeeded: 0,
      running: 1,
      pending: 0,
      failed: 0,
      cancelled: 0,
      unknown: 0,
    },
  };
  const before = structuredClone(value);
  const text = runtimePresentationMeta({}, value).text;
  const positions = [
    "先核验外部状态",
    "检查失败",
    "待 Lead 决策",
    "结果待复核",
    "本进程运行尚未收束",
  ].map((s) => text.indexOf(s));
  assert.ok(
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
    text,
  );
  assert.ok(text.indexOf("结果待复核") < text.indexOf("步骤 1：成功"));
  assert.deepEqual(value, before);
});
test("step locator uses result hash but never private report contents", () => {
  const hash = "a".repeat(64);
  const value = run('run-"', [
    item("decision_required", {
      stepId: 'worker-"',
      resultHash: hash,
      requestedDecision: "PRIVATE_QUESTION",
    }),
  ]);
  value.results = { worker: { value: "PRIVATE_RESULT" } };
  value.plan = { input: "PRIVATE_INPUT" };
  const meta = runtimePresentationMeta({}, value);
  assert.deepEqual(requests(meta.text), [
    { runId: 'run-"', stepId: 'worker-"', offset: 0, limit: 2048, hash },
  ]);
  assert.match(meta.text, /page.hash/);
  assert.doesNotMatch(
    JSON.stringify(meta),
    /PRIVATE_QUESTION|PRIVATE_RESULT|PRIVATE_INPUT/,
  );
});
test("aggregate hashes never become pagination hashes; unavailable results stay unavailable", () => {
  const hash = "b".repeat(64);
  const text = runtimePresentationMeta(
    {},
    run("review", [
      item("review_results", { resultHash: hash }),
      item("result_unavailable", { stepId: "missing" }),
    ]),
  ).text;
  assert.deepEqual(requests(text), [{ runId: "review" }, { runId: "review" }]);
  assert.ok(!text.includes(hash));
  assert.match(text, /不能通过分页恢复/);
  assert.match(text, /不使用待办聚合哈希/);
  assert.match(text, /missing/);
});
