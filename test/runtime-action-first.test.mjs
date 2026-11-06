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
  assert.match(text, /本页待办：外部状态未知 1；结果待复核 1/);
  assert.match(text, /不代表全部会话/);
  assert.match(text, /本页运行.*不代表全部待办/);
  assert.ok(text.indexOf("本页待办") < text.indexOf("本页运行"));
  const positions = ["action-old", "quiet-new", "action-new", "quiet-old"].map(
    (id) => text.indexOf(id + " ·"),
  );
  assert.match(text, /必须处理优先/);
  assert.ok(text.indexOf("action-old") < text.indexOf("详情：结果待复核"));
  assert.ok(text.indexOf("action-old ·") < text.indexOf("quiet-new ·"));
  assert.ok(
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
  );
  assert.deepEqual(value, before);
  assert.equal(
    runtimePresentationMeta({}, { runs: [] }).text,
    "本会话暂无运行。",
  );
  const repeated = runtimePresentationMeta(
    {},
    {
      runs: [
        run("one", [item("inspect_failure", { stepId: "read" })]),
        run("two", [item("inspect_failure", { stepId: "read" })]),
      ],
    },
  ).text;
  assert.match(repeated, /失败待查 2/);
  assert.match(repeated, /逐项保留运行与读取入口/);
  assert.match(repeated, /one ·/);
  assert.match(repeated, /two ·/);
  assert.deepEqual(requests(repeated), [{ runId: "one" }, { runId: "two" }]);
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
    "详情：结果待复核",
    "步骤 1：成功",
    "本进程运行尚未收束",
  ].map((s) => text.indexOf(s));
  assert.match(text, /不触发默认提醒/);
  assert.ok(
    positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
    text,
  );
  assert.ok(text.indexOf("待处理事项") < text.indexOf("详情：结果待复核"));
  assert.ok(text.indexOf("详情：结果待复核") < text.indexOf("步骤 1：成功"));
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

test("matching attention never hides another run's state, Job or result locator", () => {
  const hash = "c".repeat(64);
  const make = (id, state) => ({
    ...run(id, [item("inspect_external_state"), item("decision_required", {
      stepId: "worker", resultHash: hash,
    })]),
    state,
    guidance: [{ code: "background_job", stepId: "shell", message: "Check owned Job", jobId: "job-" + id }],
    results: { private: { value: "PRIVATE_RESULT" } },
    plan: { input: "PRIVATE_INPUT" },
  });
  const value = { runs: [make("first", "failed"), make("second", "cancelled")] };
  const before = structuredClone(value);
  const text = runtimePresentationMeta({}, value).text;
  assert.match(text, /first · failed/);
  assert.match(text, /second · cancelled/);
  assert.match(text, /job-first/);
  assert.match(text, /job-second/);
  assert.deepEqual(requests(text), [
    { runId: "first" },
    { runId: "first", stepId: "worker", offset: 0, limit: 2048, hash },
    { runId: "second" },
    { runId: "second", stepId: "worker", offset: 0, limit: 2048, hash },
  ]);
  assert.doesNotMatch(text, /PRIVATE_RESULT|PRIVATE_INPUT/);
  assert.deepEqual(value, before);
});

test("every attention kind offers read-only navigation and safe next steps", () => {
  const cases = [
    ["inspect_external_state", /核对对应步骤与后台回执/, /不要自动重发/],
    ["inspect_failure", /检查失败步骤、错误码与已保存结果/, /不重试、不绕过失败/],
    ["resume_read_only", /核对原始提交计划/, /也可能继续尚未启动的步骤/],
    ["decision_required", /读取完整 Worker 报告及证据/, /runtime_review 也不是回答 Worker 并续跑/],
    ["result_unavailable", /不能通过分页恢复/, /补取证据/],
    ["review_results", /完整保存结果与证据/, /处置不证明人工或独立验收/],
  ];
  for (const [kind, next, boundary] of cases) {
    const value = run("locate-" + kind, [item(kind)]);
    const before = structuredClone(value);
    const text = runtimePresentationMeta({}, value).text;
    assert.deepEqual(requests(text), [{ runId: value.runId }]);
    assert.match(text, next);
    assert.match(text, boundary);
    assert.doesNotMatch(text, /runtime_resume\(|runtime_review\(|job_kill\(/);
    assert.deepEqual(value, before);
  }
});
