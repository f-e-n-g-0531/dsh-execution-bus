import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ExecutionBus } from "../dist/bus.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const message = (handler, input, id = randomUUID()) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type: "request",
  payload: { handler, input },
});
const control = (type, id) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type,
  payload: {},
});
const own = (sessionId = "scheduler") => ({ sessionId, callId: "call" });

function handler(opts) {
  return {
    idempotent: opts.idempotent ?? true,
    queue: opts.queue,
    maxConcurrency: opts.maxConcurrency,
    resources: opts.resources,
    dedupe: opts.dedupe,
    validate() {},
    async run(input, ctx) {
      return opts.run(input, ctx);
    },
  };
}

const small = {
  concurrency: 2,
  queueLimit: 32,
  recordLimit: 64,
  resultBytes: 4096,
  retentionMs: 60000,
};
const scheduler = (over = {}) => ({
  queueClassOrder: { fs: 0, diagnostic: 1, command: 2, default: 3 },
  queueAgingMs: 60000,
  longRunningMs: 60000,
  ...over,
});

test("类别优先级：fs 类别优先于后到 command 类别，但不影响会话内 FIFO 语义", async () => {
  const bus = new ExecutionBus({ ...small, concurrency: 1 }, undefined, scheduler());
  const started = [];
  bus.register("cmd", handler({ queue: "command", run: async () => { started.push("cmd"); await sleep(30); return { ok: 1 }; } }));
  bus.register("fs", handler({ queue: "fs", run: async () => { started.push("fs"); await sleep(5); return { ok: 2 }; } }));
  try {
    const a = bus.submit(own(), message("cmd", {}, "cmd-1"));
    const b = bus.submit(own(), message("cmd", {}, "cmd-2"));
    const c = bus.submit(own(), message("fs", {}, "fs-1"));
    await Promise.all([a.done, b.done, c.done]);
    // 类别优先级高于提交顺序：fs 先于两个 command；同类内保持 FIFO。
    assert.deepEqual(started, ["fs", "cmd", "cmd"]);
  } finally {
    await bus.close();
  }
});

test("等待老化：后到的 fs 不会让长时间等待的 command 饥饿", async () => {
  const bus = new ExecutionBus(
    { ...small, concurrency: 1 },
    undefined,
    scheduler({ queueAgingMs: 20 }),
  );
  const started = [];
  bus.register("hold", handler({ queue: "fs", run: async () => { started.push("hold"); await sleep(80); return true; } }));
  bus.register("cmd", handler({ queue: "command", run: async () => { started.push("cmd"); return true; } }));
  bus.register("fs", handler({ queue: "fs", run: async () => { started.push("fs"); return true; } }));
  try {
    const h = bus.submit(own(), message("hold", {}, "hold-1"));
    await sleep(5);
    const c = bus.submit(own(), message("cmd", {}, "cmd-1"));
    const f = bus.submit(own(), message("fs", {}, "fs-1"));
    await Promise.all([h.done, c.done, f.done]);
    assert.deepEqual(started, ["hold", "cmd", "fs"]);
  } finally {
    await bus.close();
  }
});

test("Handler maxConcurrency 舱壁：同一 Handler 不超限，其它 Handler 可并行", async () => {
  const bus = new ExecutionBus({ ...small, concurrency: 3 });
  let active = 0;
  let peak = 0;
  let otherPeak = 0;
  bus.register("limited", handler({ maxConcurrency: 1, run: async () => {
    active++;
    peak = Math.max(peak, active);
    await sleep(30);
    active--;
    return true;
  } }));
  bus.register("other", handler({ run: async () => {
    otherPeak++;
    await sleep(40);
    return true;
  } }));
  try {
    const a = bus.submit(own(), message("limited", {}, "l1"));
    const b = bus.submit(own(), message("limited", {}, "l2"));
    const c = bus.submit(own(), message("other", {}, "o1"));
    await Promise.all([a.done, b.done, c.done]);
    assert.equal(peak, 1);
    assert.ok(otherPeak >= 1);
  } finally {
    await bus.close();
  }
});

test("资源互斥：同资源串行、不同资源可并行", async () => {
  const bus = new ExecutionBus({ ...small, concurrency: 2 });
  const spans = new Map();
  let activeSame = 0;
  let peakSame = 0;
  bus.register("file", handler({
    queue: "fs",
    resources: (input) => ["file:" + String(input.path)],
    run: async (input) => {
      activeSame++;
      peakSame = Math.max(peakSame, activeSame);
      const start = Date.now();
      await sleep(30);
      activeSame--;
      spans.set(input.path, { start, end: Date.now() });
      return true;
    },
  }));
  try {
    const same = await Promise.all([
      bus.submit(own(), message("file", { path: "a" }, "same-1")).done,
      bus.submit(own(), message("file", { path: "a" }, "same-2")).done,
    ]);
    assert.equal(peakSame, 1);
    const a = spans.get("a");
    assert.ok(a.end - a.start >= 25);
    const started = Date.now();
    const different = await Promise.all([
      bus.submit(own(), message("file", { path: "b" }, "diff-1")).done,
      bus.submit(own(), message("file", { path: "c" }, "diff-2")).done,
    ]);
    assert.ok(Date.now() - started < 60, "different resources should overlap");
    for (const v of [...same, ...different]) assert.equal(v.state, "succeeded");
  } finally {
    await bus.close();
  }
});

test("inspect：资源等待给出 resource，长时间运行给出 longRunning", async () => {
  const bus = new ExecutionBus(
    { ...small, concurrency: 2 },
    { maxQueueWaitMs: 5000 },
    scheduler({ longRunningMs: 20 }),
  );
  bus.register("lock", handler({
    resources: () => ["k"],
    run: async () => { await sleep(80); return true; },
  }));
  try {
    const first = bus.submit(own(), message("lock", {}, "long-1"));
    await sleep(10);
    const second = bus.submit(own(), message("lock", {}, "wait-2"));
    await sleep(30);
    const state = bus.inspect({ sessionId: "scheduler", callId: "inspect" });
    const running = state.tasks.find((t) => t.requestId === "long-1");
    const queued = state.tasks.find((t) => t.requestId === "wait-2");
    assert.equal(running.longRunning, true);
    assert.equal(queued.waitReason, "resource");
    await Promise.all([first.done, second.done]);
  } finally {
    await bus.close();
  }
});

test("资源等待期间仍受排队期限约束：到期不执行", async () => {
  const bus = new ExecutionBus(
    { ...small, concurrency: 2 },
    { maxQueueWaitMs: 30 },
    scheduler(),
  );
  let runs = 0;
  bus.register("lock", handler({
    resources: () => ["k"],
    run: async () => { runs++; await sleep(80); return true; },
  }));
  try {
    const first = bus.submit(own(), message("lock", {}, "hold"));
    await sleep(5);
    const second = bus.submit(own(), message("lock", {}, "expire"));
    const result = await second.done;
    assert.equal(result.state, "failed");
    assert.equal(result.error, "QUEUE_WAIT_TIMEOUT");
    await first.done;
    assert.equal(runs, 1);
  } finally {
    await bus.close();
  }
});

test("唯一任务：幂等 Handler 的相同 payload 复用已成功结果，失败不缓存", async () => {
  const bus = new ExecutionBus(small);
  let runs = 0;
  bus.register("unique", handler({
    queue: "fs",
    dedupe: "payload",
    run: async (input) => {
      runs++;
      if (input.fail === true) throw Error("boom");
      return { value: input.q, run: runs };
    },
  }));
  try {
    const first = await bus.submit(own(), message("unique", { q: 1 }, "u-1")).done;
    assert.equal(first.state, "succeeded");
    assert.equal(runs, 1);
    const reused = await bus.submit(own(), message("unique", { q: 1 }, "u-2")).done;
    assert.equal(reused.state, "succeeded");
    assert.equal(reused.requestId, "u-2");
    assert.deepEqual(reused.result, first.result);
    assert.equal(runs, 1);
    const different = await bus.submit(own(), message("unique", { q: 2 }, "u-3")).done;
    assert.equal(different.state, "succeeded");
    assert.equal(runs, 2);
    const failed = await bus.submit(own(), message("unique", { q: 3, fail: true }, "u-4")).done;
    assert.equal(failed.state, "failed");
    const retried = await bus.submit(own(), message("unique", { q: 3, fail: true }, "u-5")).done;
    assert.equal(retried.state, "failed");
    assert.equal(runs, 4, "failed results must not be reused");
    // 唯一结果的快照/控制查询与普通记录一致
    const view = bus.command(own(), control("status", "u-2"));
    assert.equal(view.state, "succeeded");
  } finally {
    await bus.close();
  }
});

test("Handler 调度选项在注册时校验", async () => {
  const bus = new ExecutionBus(small);
  const base = handler({ run: async () => 1 });
  const bad = [
    { ...base, dedupe: "payload", idempotent: false },
    { ...base, maxConcurrency: 0 },
    { ...base, queue: "" },
    { ...base, queue: "__proto__" },
    { ...base, resources: "not-a-function" },
    { ...base, idempotent: "yes" },
    { idempotent: true, run: async () => 1 },
    { idempotent: true, validate() {} },
  ];
  try {
    for (const h of bad) assert.throws(() => bus.register(randomUUID(), h), /INVALID_HANDLER_OPTIONS/);
  } finally {
    await bus.close();
  }
});

test("scheduler 策略拒绝 accessor、原型污染键与非法数值", () => {
  const accessor = {
    queueClassOrder: { fs: 0 },
    longRunningMs: 1000,
    get queueAgingMs() {
      return 1000;
    },
  };
  assert.throws(() => new ExecutionBus(small, undefined, accessor), /INVALID_OPTIONS/);
  assert.throws(
    () => new ExecutionBus(small, undefined, { queueClassOrder: { ["__proto__"]: 1 }, queueAgingMs: 10, longRunningMs: 10 }),
    /INVALID_OPTIONS/,
  );
  assert.throws(
    () => new ExecutionBus(small, undefined, { queueClassOrder: { fs: 0 }, queueAgingMs: -1, longRunningMs: 10 }),
    /INVALID_OPTIONS/,
  );
});

test("老化不封顶：default 类在 fs 类负载下也能及时出队", async () => {
  const bus = new ExecutionBus(
    { ...small, concurrency: 1 },
    undefined,
    scheduler({ queueAgingMs: 10, queueClassOrder: { fs: 0, default: 3 } }),
  );
  const started = [];
  bus.register("hold", handler({ queue: "fs", run: async () => { started.push("hold"); await sleep(40); return true; } }));
  bus.register("plain", handler({ run: async () => { started.push("default"); return true; } }));
  bus.register("fs", handler({ queue: "fs", run: async () => { started.push("fs"); return true; } }));
  try {
    const h = bus.submit(own(), message("hold", {}, "hold-d"));
    const d = bus.submit(own(), message("plain", {}, "default-d"));
    await sleep(5);
    const f = bus.submit(own(), message("fs", {}, "fs-d"));
    await Promise.all([h.done, d.done, f.done]);
    // 40ms 后 default 与 fs 都降到 0：同分按 FIFO，先提交的 default 先出队。
    assert.deepEqual(started, ["hold", "default", "fs"]);
  } finally {
    await bus.close();
  }
});

test("inspect 区分舱壁等待与资源等待", async () => {
  const bus = new ExecutionBus({ ...small, concurrency: 3 });
  bus.register("bulk", handler({ maxConcurrency: 1, run: async () => { await sleep(80); return true; } }));
  bus.register("locked", handler({ resources: () => ["k"], run: async () => { await sleep(80); return true; } }));
  try {
    const b1 = bus.submit(own(), message("bulk", {}, "bulk-1"));
    const l1 = bus.submit(own(), message("locked", {}, "lock-1"));
    await sleep(10);
    const b2 = bus.submit(own(), message("bulk", {}, "bulk-2"));
    const l2 = bus.submit(own(), message("locked", {}, "lock-2"));
    await sleep(20);
    const state = bus.inspect({ sessionId: "scheduler", callId: "inspect-bulk" });
    assert.equal(state.tasks.find((t) => t.requestId === "bulk-2").waitReason, "bulkhead");
    assert.equal(state.tasks.find((t) => t.requestId === "lock-2").waitReason, "resource");
    await Promise.all([b1.done, b2.done, l1.done, l2.done]);
  } finally {
    await bus.close();
  }
});

test("validate 同步 close 后拒绝准入，不留下永不结算的记录", async () => {
  const bus = new ExecutionBus(small);
  const closer = {
    idempotent: true,
    validate() {
      void bus.close();
    },
    async run() {
      return true;
    },
  };
  bus.register("closer", closer);
  try {
    assert.throws(() => bus.submit(own(), message("closer", {}, "close-1")), /CLOSED/);
    await bus.close();
    assert.equal(bus.diagnostics().records, 0);
    assert.equal(bus.diagnostics().phase, "closed");
  } finally {
    await bus.close();
  }
});

test("唯一复用记录计入保留字节与时间戳，sweep 后归零", async () => {
  const bus = new ExecutionBus({ ...small, retentionMs: 20 });
  let runs = 0;
  bus.register("unique", handler({
    dedupe: "payload",
    run: async (input) => ({ value: input.q, run: ++runs }),
  }));
  try {
    const first = await bus.submit(own(), message("unique", { q: 1 }, "bytes-1")).done;
    const expected = Buffer.byteLength(JSON.stringify(first.result));
    assert.equal(bus.diagnostics().retainedResultBytes, expected);
    const reused = await bus.submit(own(), message("unique", { q: 1 }, "bytes-2")).done;
    assert.equal(reused.state, "succeeded");
    assert.equal(bus.diagnostics().retainedResultBytes, expected * 2);
    const state = bus.inspect({ sessionId: "scheduler", callId: "inspect-bytes" });
    const task = state.tasks.find((t) => t.requestId === "bytes-2");
    assert.equal(task.runMs, 0);
    assert.ok(task.queueMs < 1000, "复用记录 queueMs 不应随保留期增长");
    await sleep(40);
    bus.sweep();
    assert.equal(bus.diagnostics().retainedResultBytes, 0);
  } finally {
    await bus.close();
  }
});

test("资源锁在失败与取消后释放，后续请求可继续", async () => {
  const bus = new ExecutionBus({ ...small, concurrency: 2 });
  bus.register("io", handler({
    resources: () => ["file:k"],
    run: async (input, ctx) => {
      if (input.fail === true) {
        await sleep(5);
        throw Error("boom");
      }
      if (input.cancel === true) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          ctx.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
        return true;
      }
      await sleep(5);
      return true;
    },
  }));
  try {
    const failed = await bus.submit(own(), message("io", { fail: true }, "rel-1")).done;
    assert.equal(failed.state, "failed");
    const ok = await Promise.race([
      bus.submit(own(), message("io", {}, "rel-2")).done,
      sleep(500).then(() => "timeout"),
    ]);
    assert.notEqual(ok, "timeout");
    assert.equal(ok.state, "succeeded");
    const running = bus.submit(own(), message("io", { cancel: true }, "rel-3"));
    await sleep(10);
    bus.command(own(), control("cancel", "rel-3"));
    const cancelled = await running.done;
    assert.equal(cancelled.state, "cancelled");
    const ok2 = await Promise.race([
      bus.submit(own(), message("io", {}, "rel-4")).done,
      sleep(500).then(() => "timeout"),
    ]);
    assert.notEqual(ok2, "timeout");
    assert.equal(ok2.state, "succeeded");
  } finally {
    await bus.close();
  }
});


