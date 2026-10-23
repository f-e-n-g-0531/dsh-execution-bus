import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";

const exec = () => ({
  agent: { id: "owner" },
  callId: "command-policy",
  signal: new AbortController().signal,
});
const plan = (input = {}) => ({
  steps: [
    { id: "prepare", tool: "read", input: {} },
    {
      id: "command",
      tool: "pwsh",
      input: {
        description: "Observe command result policy",
        command: "unused",
        ...input,
      },
      depends_on: ["prepare"],
    },
    { id: "publish", tool: "write", input: {}, depends_on: ["command"] },
  ],
});
function fixture(value, isError = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-command-"));
  const calls = [];
  const store = new RunStore(dir);
  const service = new RuntimeService(
    {
      tools: {
        async execute(call) {
          calls.push(call.name);
          return call.name === "pwsh"
            ? { isError, value }
            : { isError: false, value: {} };
        },
      },
    },
    store,
  );
  return {
    service,
    calls,
    store,
    async close() {
      await service.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("command success requires zero exit without timeout/abort/signal/stop/sandbox failure", async () => {
  const cases = [
    null,
    {},
    { exitCode: 1 },
    { exitCode: null },
    { exitCode: 0, timedOut: true },
    { exitCode: 0, aborted: true },
    { exitCode: 0, signal: "SIGTERM" },
    { exitCode: 0, stopped: "host cancelled" },
    { exitCode: 0, sandbox: { denied: true } },
    { exitCode: 0, sandbox: { runnerFailed: true } },
  ];
  for (const value of cases) {
    const f = fixture(value);
    try {
      const result = await f.service.run({ plan: plan() }, exec());
      assert.equal(result.state, "failed", JSON.stringify(value));
      assert.equal(
        result.steps[1].error,
        value?.timedOut ? "RUNTIME_STEP_TIMEOUT" : "RUNTIME_COMMAND_FAILED",
      );
      assert.equal(
        result.steps[1].state,
        value?.timedOut || value?.aborted || value?.signal || value?.stopped
          ? "unknown"
          : "failed",
      );
      assert.deepEqual(f.calls, ["read", "pwsh"]);
      assert.equal(f.store.load(result.runId).state, "failed");
    } finally {
      await f.close();
    }
  }
  const good = fixture({
    kind: "foreground",
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
  });
  try {
    assert.equal(
      (await good.service.run({ plan: plan() }, exec())).state,
      "succeeded",
    );
    assert.equal(good.calls.at(-1), "write");
  } finally {
    await good.close();
  }
});

test("explicit background is rejected before any plan step and no run record is admitted", async () => {
  const f = fixture({ exitCode: 0 });
  try {
    await assert.rejects(
      f.service.run({ plan: plan({ run_in_background: true }) }, exec()),
      /RUNTIME_BACKGROUND_UNSUPPORTED/,
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.service.status({}, exec()).runs, []);
  } finally {
    await f.close();
  }
});

test("unexpected background/promoted receipts retain only recoverable job handle and never publish", async () => {
  for (const kind of ["background", "promoted"]) {
    const f = fixture({
      kind,
      jobId: "tracked-job",
      output: "secret-output",
      cwd: "secret-cwd",
    });
    try {
      const result = await f.service.run({ plan: plan() }, exec());
      assert.equal(result.state, "failed");
      assert.equal(result.steps[1].state, "unknown");
      assert.equal(result.steps[1].error, "RUNTIME_BACKGROUND_UNSUPPORTED");
      assert.deepEqual(
        f.service.result({ runId: result.runId }, exec()).results.command.value,
        { kind, jobId: "tracked-job" },
      );
      assert.deepEqual(f.calls, ["read", "pwsh"]);
      assert.equal(f.store.load(result.runId).state, "failed");
    } finally {
      await f.close();
    }
  }
});

test("host isError takes precedence over a misleading zero-exit value", async () => {
  const f = fixture({ exitCode: 0 }, true);
  try {
    const result = await f.service.run({ plan: plan() }, exec());
    assert.equal(result.state, "failed");
    assert.equal(result.steps[1].error, "RUNTIME_STEP_FAILED");
    assert.deepEqual(f.calls, ["read", "pwsh"]);
  } finally {
    await f.close();
  }
});
