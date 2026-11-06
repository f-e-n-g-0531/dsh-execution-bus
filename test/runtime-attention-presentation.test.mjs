import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimePresentationMeta } from "../dist/presentation.js";

test("new attention cards compact routine progress and retain legacy fallback", () => {
  const run = {
    runId: "run-12345678",
    state: "running",
    steps: [{ id: "x", tool: "read", state: "running", attempts: 1 }],
    attention: {
      items: [],
      notification: { key: "stable", shouldNotify: false },
    },
    waiting: {
      steps: [
        { stepId: "next", reason: "dependency" },
        {
          stepId: "retry",
          reason: "retry_backoff",
          waitingSince: 10,
          nextRetryAt: 110,
          retryCategory: "transient",
          disposition: "waiting_retry",
        },
      ],
      cleanupPending: false,
    },
    guidance: [
      {
        code: "agent_requires_verification",
        message: "REPEATED_WORKER_ADVICE",
      },
    ],
  };
  const before = structuredClone(run);
  const text = runtimePresentationMeta({}, run).text;
  assert.match(text, /暂无必须处理提醒/);
  assert.match(text, /等待依赖成功/);
  assert.match(text, /只读重试退避.*110/);
  assert.match(text, /本次失败，按既有策略等待重试/);
  assert.doesNotMatch(text, /x · read|REPEATED_WORKER_ADVICE/);
  assert.deepEqual(run, before);
  const legacy = { ...run };
  delete legacy.attention;
  delete legacy.waiting;
  assert.match(runtimePresentationMeta({}, legacy).text, /x · read · running/);
  assert.match(
    runtimePresentationMeta({}, legacy).text,
    /REPEATED_WORKER_ADVICE/,
  );
});

test("attention is rendered before recovery and retains external Job advice", () => {
  const text = runtimePresentationMeta(
    {},
    {
      runId: "run-12345678",
      state: "failed",
      attention: {
        items: [
          { key: "a", kind: "inspect_external_state" },
          { key: "b", kind: "decision_required", stepId: "worker" },
        ],
        notification: { key: "k", shouldNotify: true },
      },
      recovery: {
        resultCertainty: "unknown",
        cleanup: "pending",
        nextAction: "inspect_external_state",
        message: "Check outside first",
      },
      waiting: { steps: [], cleanupPending: true },
      guidance: [
        {
          code: "background_job",
          message: "Explicit Job collection",
          jobId: "job-owned",
        },
      ],
    },
  ).text;
  assert.ok(text.indexOf("待处理事项") < text.indexOf("结果确定性"));
  assert.match(text, /未经独立核实/);
  assert.match(text, /job-owned/);
  assert.match(text, /不确认外部 Job 已退出/);
});
