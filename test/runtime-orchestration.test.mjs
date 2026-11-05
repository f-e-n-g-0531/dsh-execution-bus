import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { RuntimeService } from "../dist/runtime/service.js";

const worker = (id, depends_on = []) => ({
  id,
  tool: "agent",
  input: { prompt: "分析并给出证据：" + id },
  depends_on,
});
async function withRun(steps, invoke, inspect, concurrency = 4) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-team-"));
  try {
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, invoke);
    const run = executor.createRun("owner", parsePlan({ steps, concurrency }));
    await executor.execute(run);
    await inspect(run, store, executor);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("wire-size boundary excludes normalized worker defaults on persistence", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-wire-agent-"));
  try {
    const wire = { steps: [{ id: "a", tool: "agent", input: { prompt: "" } }] };
    wire.steps[0].input.prompt = "x".repeat(
      65536 - Buffer.byteLength(JSON.stringify(wire)),
    );
    assert.equal(Buffer.byteLength(JSON.stringify(wire)), 65536);
    const store = new RunStore(dir);
    const executor = new RuntimeExecutor(store, async () => null);
    const run = executor.createRun("owner", parsePlan(wire));
    assert.equal(store.load(run.runId).plan.steps[0].input.max_steps, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent protocol rejects retries and malformed worker inputs", () => {
  assert.throws(
    () => parsePlan({ steps: [{ ...worker("a"), retry: 1 }] }),
    /PLAN_RETRY_DENIED/,
  );
  for (const input of [
    {},
    { prompt: "" },
    { prompt: "x", unknown: true },
    { prompt: "x", max_steps: 0 },
    { prompt: "x", access: "write" },
  ])
    assert.throws(() => parsePlan({ steps: [{ ...worker("a"), input }] }));
});

test("parallel workers feed saved dependency results to a reviewer without mutating plan", async () => {
  let active = 0,
    peak = 0;
  const prompts = [];
  await withRun(
    [worker("a"), worker("b"), worker("review", ["a", "b"])],
    async (tool, input, signal, onCreated) => {
      assert.equal(tool, "agent");
      onCreated("child-" + prompts.length);
      prompts.push(input.prompt);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return {
        sessionId: "s",
        output: input.prompt,
        verification: "not_independently_verified",
      };
    },
    (run, store) => {
      assert.equal(run.state, "succeeded");
      assert.equal(peak, 2);
      assert.match(prompts[2], /不可信资料/);
      assert.match(prompts[2], /"id":"a"/);
      assert.match(prompts[2], /"id":"b"/);
      assert.doesNotMatch(run.plan.steps[2].input.prompt, /不可信资料/);
      assert.equal(store.load(run.runId).steps[0].childSessionId, "child-0");
    },
  );
});

test("agent batches do not overlap direct mutating steps", async () => {
  let active = 0;
  await withRun(
    [worker("a"), { id: "write", tool: "write", input: {} }, worker("b")],
    async () => {
      assert.equal(active, 0);
      active++;
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return {};
    },
    (run) => assert.equal(run.state, "succeeded"),
  );
});

test("truncated dependencies fail before downstream worker starts", async () => {
  let calls = 0;
  await withRun(
    [worker("a"), worker("review", ["a"])],
    async () => {
      calls++;
      return "x".repeat(70000);
    },
    (run) => {
      assert.equal(calls, 1);
      assert.equal(run.state, "failed");
      assert.equal(run.steps[1].error, "RUNTIME_AGENT_DEPENDENCY_UNAVAILABLE");
    },
  );
});

test("aggregate context limit fails closed instead of dropping upstream evidence", async () => {
  let calls = 0;
  await withRun(
    [worker("a"), worker("b"), worker("review", ["a", "b"])],
    async () => {
      calls++;
      return "x".repeat(33000);
    },
    (run) => {
      assert.equal(calls, 2);
      assert.equal(run.steps[2].error, "RUNTIME_AGENT_CONTEXT_TOO_LARGE");
    },
  );
});

test("interrupted agent is never replayed and prevents pending work", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-resume-agent-"));
  try {
    const store = new RunStore(dir);
    let calls = 0;
    const executor = new RuntimeExecutor(store, async () => {
      calls++;
    });
    const run = executor.createRun(
      "owner",
      parsePlan({ steps: [worker("a"), worker("b")] }),
    );
    run.state = "interrupted";
    run.finishedAt = run.updatedAt;
    Object.assign(run.steps[0], {
      state: "unknown",
      attempts: 1,
      startedAt: run.createdAt,
      finishedAt: run.updatedAt,
      childSessionId: "child",
    });
    store.save(run);
    await executor.resume(run);
    assert.equal(calls, 0);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[1].state, "pending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel waits for owned worker cleanup and keeps child receipt", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-cancel-agent-"));
  try {
    const store = new RunStore(dir);
    const controller = new AbortController();
    let entered;
    const started = new Promise((r) => {
      entered = r;
    });
    let release;
    let cleaned = false;
    const executor = new RuntimeExecutor(
      store,
      async (t, i, signal, onCreated) => {
        onCreated("child-live");
        entered();
        await new Promise((r) =>
          signal.addEventListener("abort", r, { once: true }),
        );
        await new Promise((r) => {
          release = r;
        });
        cleaned = true;
        throw Error("RUNTIME_AGENT_CANCELLED");
      },
    );
    const run = executor.createRun(
      "owner",
      parsePlan({ steps: [worker("a")] }),
    );
    let settled = false;
    const done = executor.execute(run, controller.signal).then(() => {
      settled = true;
    });
    await started;
    controller.abort();
    await new Promise((r) => setImmediate(r));
    assert.equal(settled, false);
    release();
    await done;
    assert.equal(cleaned, true);
    assert.equal(run.steps[0].state, "unknown");
    assert.equal(store.load(run.runId).steps[0].childSessionId, "child-live");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent async is rejected before recording or starting work", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-async-agent-"));
  const store = new RunStore(dir);
  const service = new RuntimeService({}, store);
  const exec = { agent: { id: "owner" }, signal: new AbortController().signal };
  try {
    await assert.rejects(
      service.run({ plan: { steps: [worker("a")] }, async: true }, exec),
      /RUNTIME_AGENT_ASYNC_UNSUPPORTED/,
    );
    await assert.rejects(
      service.run({ plan: { steps: [worker("a")] } }, exec, true),
      /RUNTIME_AGENT_ASYNC_UNSUPPORTED/,
    );
    assert.deepEqual(store.list(), []);
  } finally {
    await service.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker trace survives failure and reload without accepting malformed audit metadata", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-trace-"));
  try {
    const { promptHash, validWorkerTrace } = await import(
      "../dist/runtime/agent-trace.js"
    );
    const store = new RunStore(dir);
    const trace = {
      promptVersion: "xiaohe-worker-v1",
      promptHash: promptHash("role"),
      taskPromptHash: promptHash("task"),
      outputFormat: "report",
      selectedModel: { provider: "offline", model: "fixture" },
      requestModels: [
        { provider: "offline", model: "resolved", reasoningEffort: "high" },
      ],
    };
    let calls = 0;
    const executor = new RuntimeExecutor(
      store,
      async (_tool, _input, _signal, onCreated) => {
        calls++;
        onCreated("child-trace", trace);
        throw Error("RUNTIME_AGENT_REPORT_INVALID");
      },
    );
    const run = executor.createRun(
      "owner",
      parsePlan({
        steps: [
          {
            ...worker("a"),
            input: { prompt: "task", output_format: "report" },
          },
        ],
      }),
    );
    await executor.execute(run);
    assert.equal(calls, 1);
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].error, "RUNTIME_AGENT_REPORT_INVALID");
    assert.deepEqual(
      new RunStore(dir).load(run.runId).steps[0].workerTrace,
      trace,
    );
    const service = new RuntimeService({}, store);
    try {
      const exec = { agent: { id: "owner" } };
      const summary = service.status({ runId: run.runId }, exec);
      summary.steps[0].workerTrace.requestModels.length = 0;
      assert.equal(
        service.status({ runId: run.runId }, exec).steps[0].workerTrace
          .requestModels.length,
        1,
      );
    } finally {
      await service.dispose();
    }
    for (const mutate of [
      (x) => {
        x.workerTrace.promptHash = "bad";
      },
      (x) => {
        x.workerTrace.selectedModel.extra = true;
      },
      (x) => {
        x.workerTrace.requestModels = Array(65).fill(trace.selectedModel);
      },
      (x) => {
        x.workerTrace.outputFormat = "json";
      },
      (x) => {
        delete x.childSessionId;
      },
      (x) => {
        x.tool = "read";
      },
    ]) {
      const bad = structuredClone(run);
      mutate(bad.steps[0]);
      assert.throws(() => store.save(bad));
    }
    assert.equal(validWorkerTrace(trace), true);
    assert.deepEqual(store.load(run.runId).steps[0].workerTrace, trace);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
