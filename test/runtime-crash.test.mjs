import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunStore } from "../dist/runtime/store.js";

const childFile = fileURLToPath(
  new URL("./fixtures/runtime-child.mjs", import.meta.url),
);
async function bounded(promise, label, ms = 8000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Timed out: " + label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function launch(root, cwd, scenario, mode, runId = "") {
  const child = fork(childFile, [root, scenario, mode, runId], {
    cwd,
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const queue = [];
  const waiters = new Set();
  let ended = false;
  let failure;
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      ended = true;
      resolve({ code, signal });
      for (const waiter of waiters)
        waiter.reject(
          Error(
            "Child exited before " + waiter.type + ": " + code + "/" + signal,
          ),
        );
      waiters.clear();
    });
    child.once("error", (error) => {
      failure = error;
      ended = true;
      resolve({ error: error.message });
      for (const waiter of waiters) waiter.reject(error);
      waiters.clear();
    });
  });
  child.on("message", (message) => {
    if (message.type === "fatal") {
      failure = Error(message.error);
      for (const waiter of waiters) waiter.reject(failure);
      waiters.clear();
      return;
    }
    const waiter = [...waiters].find(
      (candidate) => candidate.type === message.type,
    );
    if (waiter) {
      waiters.delete(waiter);
      waiter.resolve(message);
    } else queue.push(message);
  });
  return {
    child,
    exit,
    async message(type) {
      if (failure) throw failure;
      const index = queue.findIndex((message) => message.type === type);
      if (index !== -1) return queue.splice(index, 1)[0];
      if (ended) throw Error("Child already exited before " + type);
      let waiter;
      try {
        return await bounded(
          new Promise((resolve, reject) => {
            waiter = { type, resolve, reject };
            waiters.add(waiter);
          }),
          "child IPC " + type,
        );
      } finally {
        waiters.delete(waiter);
      }
    },
    async go() {
      return new Promise((resolve, reject) =>
        child.send({ type: "go" }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    async kill() {
      if (!ended) child.kill("SIGKILL");
      return bounded(exit, "child kill/exit");
    },
  };
}
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-crash-"));
  const cwd = path.join(dir, "isolated-cwd");
  const root = path.join(dir, "runs");
  mkdirSync(cwd);
  mkdirSync(root);
  const children = [];
  return {
    dir,
    cwd,
    root,
    spawn(scenario, mode, runId) {
      const handle = launch(root, cwd, scenario, mode, runId);
      children.push(handle);
      return handle;
    },
    effects() {
      return readFileSync(path.join(cwd, "effects.ndjson"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async close() {
      await Promise.all(children.map((handle) => handle.kill()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test(
  "real crash: durable fast write is never replayed while same-batch slow read is rescheduled",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const first = f.spawn("completed-write", "start");
      const ready = await first.message("ready");
      assert.equal(ready.cwd, f.cwd);
      assert.notEqual(ready.cwd, process.cwd());
      await first.go();
      const checkpoint = await first.message("checkpoint");
      const started = await first.message("started");
      assert.equal(checkpoint.runId, started.runId);
      assert.equal(checkpoint.record.state, "running");
      assert.deepEqual(
        checkpoint.record.steps.map((step) => step.state),
        ["succeeded", "running"],
      );
      const store = new RunStore(f.root);
      const durable = store.load(started.runId);
      assert.equal(durable.steps[0].state, "succeeded");
      assert.deepEqual(durable.results.fast.value, {
        tag: "fast",
        content: "result:fast",
      });
      assert.equal(
        f.effects().filter((entry) => entry.tag === "fast").length,
        1,
      );
      // Exit acknowledgement is essential: recovery must not race a live PID.
      await first.kill();
      assert.equal(
        store.load(started.runId).state,
        "running",
        "SIGKILL must not execute graceful disposal",
      );

      const second = f.spawn("completed-write", "resume", started.runId);
      await second.message("ready");
      await second.go();
      const recovered = await second.message("result");
      const exited = await bounded(second.exit, "recovery exit");
      assert.equal(exited.code, 0);
      assert.equal(recovered.before.state, "interrupted");
      assert.deepEqual(
        recovered.before.steps.map((step) => step.state),
        ["succeeded", "unknown"],
      );
      assert.equal(recovered.resumed.state, "succeeded");
      assert.equal(recovered.result.finished, true);
      assert.deepEqual(
        recovered.result.steps.map((step) => step.attempts),
        [1, 2],
      );
      assert.deepEqual(recovered.result.results.fast, durable.results.fast);
      assert.deepEqual(recovered.result.results.slow.value, {
        tag: "slow",
        content: "result:slow",
      });
      const effects = f.effects();
      assert.equal(effects.filter((entry) => entry.tag === "fast").length, 1);
      assert.equal(effects.filter((entry) => entry.tag === "slow").length, 2);
      assert.equal(
        new Set(
          effects
            .filter((entry) => entry.tag === "slow")
            .map((entry) => entry.pid),
        ).size,
        2,
      );
      assert.equal(store.load(started.runId).state, "succeeded");
    } finally {
      await f.close();
    }
  },
);

test(
  "real crash: in-flight unknown write stops resume without replay or unrelated later side effects",
  { timeout: 30000 },
  async () => {
    const f = fixture();
    try {
      const first = f.spawn("inflight-write", "start");
      await first.message("ready");
      await first.go();
      const barrier = await first.message("write-entered");
      const started = await first.message("started");
      assert.equal(barrier.runId, started.runId);
      assert.deepEqual(
        barrier.record.steps.map((step) => step.state),
        ["running", "pending"],
      );
      assert.deepEqual(
        f.effects().map((entry) => entry.tag),
        ["uncertain"],
      );
      await first.kill();

      const second = f.spawn("inflight-write", "resume", started.runId);
      await second.message("ready");
      await second.go();
      const recovered = await second.message("result");
      assert.equal(
        (await bounded(second.exit, "failed recovery exit")).code,
        0,
      );
      assert.equal(recovered.before.state, "interrupted");
      assert.equal(recovered.before.steps[0].state, "unknown");
      assert.equal(recovered.resumed.state, "failed");
      assert.equal(recovered.result.error, "RUNTIME_INTERRUPTED");
      assert.deepEqual(
        recovered.result.steps.map((step) => step.state),
        ["failed", "pending"],
      );
      assert.deepEqual(
        recovered.result.steps.map((step) => step.attempts),
        [1, 0],
      );
      assert.deepEqual(recovered.result.results, {});
      assert.deepEqual(
        f.effects().map((entry) => entry.tag),
        ["uncertain"],
      );
      assert.equal(new RunStore(f.root).load(started.runId).state, "failed");
    } finally {
      await f.close();
    }
  },
);
