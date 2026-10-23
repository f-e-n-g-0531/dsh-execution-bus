import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-store-"));
const id = (n) => "run-" + n.toString(36).padStart(8, "0");
const run = (
  runId,
  state = "running",
  steps = [{ id: "a", tool: "read", state: "pending", attempts: 0 }],
) => {
  const records = structuredClone(steps);
  if (state === "succeeded") {
    for (const step of records)
      Object.assign(step, {
        state: "succeeded",
        attempts: 1,
        startedAt: 2,
        finishedAt: 3,
      });
  }
  return {
    version: 1,
    runId,
    ownerSessionId: "s1",
    plan: parsePlan({
      steps: records.map(({ id, tool }) => ({
        id,
        tool,
        input: { file_path: "x" },
      })),
    }),
    state,
    steps: records,
    results: Object.fromEntries(
      records
        .filter((step) => step.state === "succeeded")
        .map((step) => [step.id, { value: null, bytes: 0 }]),
    ),
    createdAt: 1,
    updatedAt: 10,
    ...(state === "running" ? {} : { finishedAt: 10 }),
  };
};
const fixture = (fn) => {
  const dir = tmp();
  try {
    return fn(new RunStore(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const withMock = (object, name, replacement, fn) => {
  const mocked = mock.method(object, name, replacement);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
};
const errno = (code) =>
  Object.assign(Error("private-file-path: secret payload"), { code });

test("运行记录：version1 原子保存、读取、列表与路径保护", () =>
  fixture((store, dir) => {
    store.save(run("run-aaaaaaaa"));
    store.save(run("run-bbbbbbbb", "succeeded"));
    assert.equal(store.load("run-aaaaaaaa")?.state, "running");
    assert.deepEqual(
      store.list(10).map((r) => r.runId),
      ["run-aaaaaaaa", "run-bbbbbbbb"],
    );
    store.remove("run-aaaaaaaa");
    assert.equal(store.load("run-aaaaaaaa"), undefined);
    assert.throws(() => store.pathFor("../escape"), /RUNTIME_NOT_FOUND/);
    assert.equal(store.load("../escape"), undefined);
    const target = path.join(dir, "run-bbbbbbbb.json");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(target, "utf8")),
      run("run-bbbbbbbb", "succeeded"),
    );
    if (process.platform !== "win32")
      assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["run-bbbbbbbb.json"]);
  }));

test("分页：先按owner过滤，再按updatedAt降序稳定分页", () =>
  fixture((store) => {
    for (let n = 1; n <= 45; n++) {
      const record = run(id(n));
      record.updatedAt = n + 10;
      record.ownerSessionId = n % 2 ? "s1" : "s2";
      store.save(record);
    }
    assert.equal(store.list().length, 20);
    assert.equal(store.list(100, "s1").length, 23);
    assert.deepEqual(
      store.list(2, "s1", 1).map((r) => r.runId),
      [id(43), id(41)],
    );
    assert.deepEqual(store.list(2, "missing", 0), []);
    assert.deepEqual(store.list(0, "s1"), []);
    assert.deepEqual(store.list(20, undefined, 100), []);
    for (const bad of [-1, 1.5, Infinity, NaN]) {
      assert.throws(() => store.list(bad), /RUNTIME_INVALID_STATE/);
      assert.throws(
        () => store.list(1, undefined, bad),
        /RUNTIME_INVALID_STATE/,
      );
    }
  }));

test("prune：只计终态预算，不删除running/interrupted，持续清理最新记录", () =>
  fixture((store) => {
    for (let n = 1; n <= 5; n++) {
      const record = run(
        id(n),
        n === 3 ? "failed" : n === 4 ? "cancelled" : "succeeded",
      );
      if (record.state === "cancelled")
        Object.assign(record.steps[0], { state: "cancelled", finishedAt: 3 });
      record.updatedAt = n + 10;
      store.save(record);
    }
    store.save(run(id(6)));
    store.save(run(id(7), "interrupted"));
    store.prune(2);
    assert.deepEqual(
      store
        .list(100)
        .map((r) => r.runId)
        .sort(),
      [id(4), id(5), id(6), id(7)],
    );
    store.save(run(id(8), "succeeded"));
    store.prune(2);
    assert.equal(store.load(id(8)), undefined); // Its older timestamp does not evict newer records.
    store.prune(0);
    assert.deepEqual(
      store
        .list(100)
        .map((r) => r.state)
        .sort(),
      ["interrupted", "running"],
    );
    assert.throws(() => store.prune(-1), /RUNTIME_INVALID_STATE/);
  }));

test("prune默认保留100个终态，恢复扫描不受旧1000条限制", () =>
  fixture((store) => {
    for (let n = 1; n <= 105; n++) store.save(run(id(n), "succeeded"));
    store.prune();
    assert.equal(store.list(1000).length, 100);
    for (let n = 200; n <= 1205; n++) {
      const record = run(id(n));
      fs.writeFileSync(store.pathFor(record.runId), JSON.stringify(record));
    }
    assert.equal(store.markInterrupted(), 1006);
    assert.equal(
      store.list(2000).filter((record) => record.state === "running").length,
      0,
    );
    store.prune(0);
    assert.equal(store.list(2000).length, 1006);
  }));

test("恢复：legacy running变interrupted，运行步骤unknown，排除active IDs", () =>
  fixture((store) => {
    store.save(
      run(id(1), "running", [
        { id: "a", tool: "read", state: "running", attempts: 1, startedAt: 2 },
        { id: "b", tool: "write", state: "pending", attempts: 0 },
      ]),
    );
    const own = run(id(2));
    Object.assign(own, { ownerPid: process.pid, ownerProcess: "this-process" });
    store.save(own);
    store.save(run(id(3), "succeeded"));
    assert.equal(store.markInterrupted(new Set([id(2)])), 1);
    const interrupted = store.load(id(1));
    assert.equal(interrupted?.state, "interrupted");
    assert.equal(interrupted?.steps[0].state, "unknown");
    assert.equal(interrupted?.steps[1].state, "pending");
    assert.equal(interrupted?.finishedAt, interrupted?.steps[0].finishedAt);
    assert.equal(store.load(id(2))?.state, "running");
    assert.equal(store.markInterrupted(), 1); // Same-PID orphan is recoverable after a service remount.
    assert.equal(store.markInterrupted(), 0);
    assert.equal(store.load(id(3))?.state, "succeeded");
  }));

test("恢复：外部活进程和EPERM跳过，ESRCH恢复，未识别探测错误保守跳过", () =>
  fixture((store) => {
    for (let n = 1; n <= 4; n++) {
      const record = run(id(n));
      record.ownerPid = process.pid + 100 + n;
      store.save(record);
    }
    const alive = process.pid + 101;
    const denied = process.pid + 102;
    const dead = process.pid + 103;
    withMock(
      process,
      "kill",
      (pid, signal) => {
        assert.equal(signal, 0);
        if (pid === alive) return true;
        throw errno(
          pid === denied ? "EPERM" : pid === dead ? "ESRCH" : "EINVAL",
        );
      },
      () => assert.equal(store.markInterrupted(), 1),
    );
    assert.equal(store.load(id(1))?.state, "running");
    assert.equal(store.load(id(2))?.state, "running");
    assert.equal(store.load(id(3))?.state, "interrupted");
    assert.equal(store.load(id(4))?.state, "running");
  }));

test("校验：坏JSON/版本/owner/Plan/steps/results/state/timestamps逐个隔离", () =>
  fixture((store, dir) => {
    const mutations = [
      (r) => {
        r.version = 2;
      },
      (r) => {
        r.runId = id(999);
      },
      (r) => {
        delete r.ownerSessionId;
      },
      (r) => {
        r.ownerSessionId = " ";
      },
      (r) => {
        r.ownerSessionId = 1;
      },
      (r) => {
        r.ownerPid = 0;
      },
      (r) => {
        r.ownerPid = 1.5;
      },
      (r) => {
        r.ownerProcess = {};
      },
      (r) => {
        r.ownerProcess = "";
      },
      (r) => {
        r.plan = null;
      },
      (r) => {
        r.plan.steps = null;
      },
      (r) => {
        r.plan.steps = [];
      },
      (r) => {
        r.plan.steps[0] = null;
      },
      (r) => {
        r.plan.steps[0].tool = "ask_user_question";
      },
      (r) => {
        r.plan.steps[0].input = null;
      },
      (r) => {
        r.plan.steps[0].dependsOn = ["missing"];
      },
      (r) => {
        r.plan.steps[0].dependsOn = ["a"];
      },
      (r) => {
        r.plan.steps[0].retry = -1;
      },
      (r) => {
        r.plan.steps[0].timeoutMs = 1;
      },
      (r) => {
        r.plan.steps[0].timeout_ms = 1000;
      },
      (r) => {
        delete r.plan.steps[0].dependsOn;
      },
      (r) => {
        r.plan.concurrency = 5;
      },
      (r) => {
        r.plan.steps.push(structuredClone(r.plan.steps[0]));
      },
      (r) => {
        r.plan.goal = "mismatched";
      },
      (r) => {
        r.goal = 1;
      },
      (r) => {
        r.steps = null;
      },
      (r) => {
        r.steps = [null];
      },
      (r) => {
        r.steps = [];
      },
      (r) => {
        r.steps.push(structuredClone(r.steps[0]));
      },
      (r) => {
        r.steps[0].id = "other";
      },
      (r) => {
        r.steps[0].tool = "write";
      },
      (r) => {
        r.steps[0].attempts = -1;
      },
      (r) => {
        r.steps[0].state = "mystery";
      },
      (r) => {
        r.steps[0].state = "running";
        r.steps[0].attempts = 1;
      },
      (r) => {
        r.steps[0].finishedAt = 5;
      },
      (r) => {
        r.results = null;
      },
      (r) => {
        r.results.a = { value: 1 };
      },
      (r) => {
        r.results.other = { value: 1 };
      },
      (r) => {
        r.state = "mystery";
      },
      (r) => {
        r.state = "succeeded";
        r.finishedAt = 10;
      },
      (r) => {
        r.state = "interrupted";
      },
      (r) => {
        r.finishedAt = 10;
      },
      (r) => {
        r.createdAt = -1;
      },
      (r) => {
        r.updatedAt = 0;
      },
      (r) => {
        r.updatedAt = "10";
      },
      (r) => {
        r.error = {};
      },
    ];
    store.save(run(id(999), "succeeded"));
    for (const [n, mutate] of mutations.entries()) {
      const record = run(id(n));
      mutate(record);
      fs.writeFileSync(store.pathFor(id(n)), JSON.stringify(record));
      assert.equal(store.load(id(n)), undefined, `mutation ${n}`);
    }
    fs.writeFileSync(store.pathFor(id(1000)), "{not json: private content");
    assert.equal(store.load(id(1000)), undefined);
    assert.equal(store.list(100).length, 1);
    assert.equal(store.markInterrupted(), 0);
    const diagnostics = store.diagnostics();
    assert.ok(diagnostics.invalidRecords >= mutations.length + 1);
    assert.deepEqual(Object.keys(diagnostics).sort(), [
      "invalidRecords",
      "oversizedRecords",
      "readFailures",
      "writeFailures",
    ]);
    assert.ok(!JSON.stringify(diagnostics).includes(dir));
    diagnostics.invalidRecords = 0;
    assert.ok(store.diagnostics().invalidRecords > 0);
  }));

test("校验：每种白名单工具及合法DAG内部Plan可round trip", () =>
  fixture((store) => {
    const tools = ["read", "glob", "grep", "edit", "write", "pwsh"];
    const record = run(
      id(1),
      "running",
      tools.map((tool, n) => ({
        id: "s" + n,
        tool,
        state: "pending",
        attempts: 0,
      })),
    );
    record.plan = parsePlan({
      goal: "validated goal",
      concurrency: 4,
      steps: tools.map((tool, n) => ({
        id: "s" + n,
        tool,
        input: {},
        ...(n ? { depends_on: ["s" + (n - 1)] } : {}),
      })),
    });
    record.goal = record.plan.goal;
    store.save(record);
    assert.deepEqual(store.load(id(1)), record);
    record.plan.steps[0].dependsOn = ["s5"];
    fs.writeFileSync(store.pathFor(id(1)), JSON.stringify(record));
    assert.equal(store.load(id(1)), undefined); // Cycle through all six steps.
  }));

test("Plan原始输入精确65536字节：归一化默认值不占用持久化校验预算", () =>
  fixture((store) => {
    const raw = {
      steps: [
        { id: "a", tool: "read", input: { file_path: "x".repeat(65475) } },
      ],
    };
    assert.equal(Buffer.byteLength(JSON.stringify(raw)), 65536);
    const plan = parsePlan(raw);
    assert.ok(Buffer.byteLength(JSON.stringify(plan)) > 65536);
    const executor = new RuntimeExecutor(store, async () => null);
    const record = executor.createRun("s1", plan);
    store.save(record);
    assert.deepEqual(store.load(record.runId), record);
    const invalid = structuredClone(record);
    invalid.plan.steps[0].input.file_path += "x";
    assert.throws(() => store.save(invalid), /RUNTIME_INVALID_STATE/);
    fs.writeFileSync(store.pathFor(record.runId), JSON.stringify(invalid));
    assert.equal(store.load(record.runId), undefined);
    raw.steps[0].input.file_path += "x";
    assert.throws(() => parsePlan(raw), /PLAN_TOO_LARGE/);
  }));

test("校验：成功结果、截断结果、unknown后台回执及恢复累计attempts", () =>
  fixture((store) => {
    const valid = [
      run(id(1), "succeeded"),
      run(id(2), "succeeded"),
      run(id(3), "succeeded"),
      run(id(4), "failed", [
        {
          id: "a",
          tool: "pwsh",
          state: "unknown",
          attempts: 1,
          startedAt: 2,
          finishedAt: 3,
        },
      ]),
      run(id(5), "running", [
        { id: "a", tool: "read", state: "pending", attempts: 100 },
      ]),
      run(id(6), "cancelled", [
        {
          id: "a",
          tool: "read",
          state: "cancelled",
          attempts: 0,
          finishedAt: 3,
        },
      ]),
    ];
    valid[1].results.a = { truncated: true, bytes: 100000 };
    valid[2].results.a = { truncated: true };
    valid[3].results.a = { value: { jobId: "job-1" }, bytes: 17 };
    for (const record of valid) {
      store.save(record);
      assert.deepEqual(store.load(record.runId), record);
    }
    const badResults = [
      null,
      [],
      {},
      { bytes: -1, value: 1 },
      { truncated: false },
      { truncated: true, value: 1 },
      { value: "x".repeat(65536) },
    ];
    for (const result of badResults) {
      const record = run(id(10), "succeeded");
      record.results.a = result;
      fs.writeFileSync(store.pathFor(id(10)), JSON.stringify(record));
      assert.equal(store.load(id(10)), undefined);
    }
    const record = run(id(10), "succeeded");
    delete record.results.a;
    assert.throws(() => store.save(record), /RUNTIME_INVALID_STATE/);
    record.results.a = { value: null };
    record.steps[0].finishedAt = 1;
    assert.throws(() => store.save(record), /RUNTIME_INVALID_STATE/);
  }));

test("恢复副作用失败仍保留有界后台回执，不放宽结果结构校验", () =>
  fixture((store) => {
    const record = run(id(1), "interrupted", [
      {
        id: "a",
        tool: "pwsh",
        state: "unknown",
        attempts: 1,
        startedAt: 2,
        finishedAt: 3,
      },
    ]);
    const value = { kind: "background", jobId: "job-recover-1" };
    record.results.a = {
      value,
      bytes: Buffer.byteLength(JSON.stringify(value)),
    };
    store.save(record);
    const resumed = store.load(id(1));
    resumed.state = "failed";
    resumed.error = "RUNTIME_INTERRUPTED";
    resumed.steps[0].state = "failed";
    resumed.steps[0].error = "RUNTIME_INTERRUPTED";
    store.save(resumed);
    assert.deepEqual(store.load(id(1))?.results.a, record.results.a);
    resumed.results.a = { truncated: true, bytes: 100000 };
    store.save(resumed);
    assert.deepEqual(store.load(id(1))?.results.a, resumed.results.a);
    resumed.results.a = { value: "x".repeat(65536) };
    assert.throws(() => store.save(resumed), /RUNTIME_INVALID_STATE/);
    resumed.results.a = { value, bytes: 1 };
    assert.throws(() => store.save(resumed), /RUNTIME_INVALID_STATE/);
  }));

test("检查点：混合批次、幂等retry pending及跨步骤依赖一致性", () =>
  fixture((store) => {
    const record = run(id(1), "running", [
      {
        id: "a",
        tool: "read",
        state: "succeeded",
        attempts: 1,
        startedAt: 2,
        finishedAt: 3,
      },
      { id: "b", tool: "read", state: "running", attempts: 1, startedAt: 4 },
      { id: "c", tool: "read", state: "pending", attempts: 0 },
    ]);
    record.plan.steps[1].dependsOn = ["a"];
    record.plan.steps[2].dependsOn = ["b"];
    store.save(record);
    assert.deepEqual(store.load(id(1)), record);
    Object.assign(record.steps[1], {
      state: "pending",
      error: "RUNTIME_STEP_FAILED",
    });
    store.save(record);
    const invalids = [
      (r) => {
        r.steps[1].startedAt = 2;
      },
      (r) => {
        r.steps[2] = {
          ...r.steps[2],
          state: "running",
          attempts: 1,
          startedAt: 5,
        };
      },
      (r) => {
        r.steps[0].error = "wrong";
      },
      (r) => {
        r.results.a.bytes = 100;
      },
      (r) => {
        r.results.a = { truncated: true, bytes: 5 };
      },
      (r) => {
        r.steps[0].startedAt = 11;
      },
    ];
    for (const mutate of invalids) {
      const invalid = structuredClone(record);
      mutate(invalid);
      fs.writeFileSync(store.pathFor(id(1)), JSON.stringify(invalid));
      assert.equal(store.load(id(1)), undefined);
    }
  }));

test("4MiB记录边界可读取，超过1字节不可读取或保存", () =>
  fixture((store) => {
    const record = { ...run(id(1)), error: "" };
    record.error = "x".repeat(
      4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(record)),
    );
    assert.equal(Buffer.byteLength(JSON.stringify(record)), 4 * 1024 * 1024);
    store.save(record);
    assert.equal(store.load(id(1))?.error.length, record.error.length);
    record.error += "x";
    assert.throws(() => store.save(record), /RUNTIME_INVALID_STATE/);
    fs.writeFileSync(store.pathFor(id(1)), JSON.stringify(record));
    assert.equal(store.load(id(1)), undefined);
  }));

test("超大文件：stat先拒绝，不读取payload；增长文件也有界拒绝", () =>
  fixture((store) => {
    fs.writeFileSync(store.pathFor(id(1)), "x".repeat(4 * 1024 * 1024 + 1));
    withMock(
      fs,
      "readSync",
      () => {
        assert.fail("must reject oversized file before reading");
      },
      () => {
        assert.equal(store.load(id(1)), undefined);
      },
    );
    assert.equal(store.diagnostics().oversizedRecords, 1);
    store.save(run(id(2)));
    const actualFstat = fs.fstatSync;
    withMock(
      fs,
      "fstatSync",
      (fd) => {
        const stat = actualFstat(fd);
        stat.size = 1; // Emulate a file growing between stat and read.
        return stat;
      },
      () => assert.equal(store.load(id(2)), undefined),
    );
    assert.equal(store.diagnostics().invalidRecords, 1);
  }));

test("存储故障：唯一0600临时文件、写失败清理、原记录不变、抛稳定脱敏错误", () =>
  fixture((store, dir) => {
    const record = run(id(1));
    store.save(record);
    const original = fs.readFileSync(store.pathFor(id(1)), "utf8");
    const actualOpen = fs.openSync;
    const temps = [];
    const modes = [];
    withMock(
      fs,
      "openSync",
      (file, flags, mode) => {
        if (flags === "wx") {
          temps.push(file);
          modes.push(mode);
        }
        return actualOpen(file, flags, mode);
      },
      () => {
        for (let n = 0; n < 2; n++)
          withMock(
            fs,
            "writeFileSync",
            () => {
              throw errno("ENOSPC");
            },
            () => {
              assert.throws(
                () => store.save(record),
                (error) => error.message === "RUNTIME_STORAGE_FAILED",
              );
            },
          );
      },
    );
    assert.equal(new Set(temps).size, 2);
    assert.deepEqual(modes, [0o600, 0o600]);
    assert.equal(fs.readFileSync(store.pathFor(id(1)), "utf8"), original);
    assert.deepEqual(fs.readdirSync(dir), [id(1) + ".json"]);
    withMock(
      fs,
      "renameSync",
      () => {
        throw errno("EACCES");
      },
      () => {
        assert.throws(
          () => store.save(record),
          /^Error: RUNTIME_STORAGE_FAILED$/,
        );
      },
    );
    assert.deepEqual(fs.readdirSync(dir), [id(1) + ".json"]);
    assert.equal(fs.readFileSync(store.pathFor(id(1)), "utf8"), original);
    assert.equal(store.diagnostics().writeFailures, 3);
  }));

test("故障：open/read/readdir/remove/构造失败全部稳定隔离或脱敏", () =>
  fixture((store) => {
    const record = run(id(1));
    store.save(record);
    withMock(
      fs,
      "openSync",
      () => {
        throw errno("EACCES");
      },
      () => {
        assert.equal(store.load(id(1)), undefined);
        assert.throws(
          () => store.save(record),
          /^Error: RUNTIME_STORAGE_FAILED$/,
        );
      },
    );
    withMock(
      fs,
      "readSync",
      () => {
        throw errno("EIO");
      },
      () => assert.equal(store.load(id(1)), undefined),
    );
    withMock(
      fs,
      "readdirSync",
      () => {
        throw errno("EACCES");
      },
      () => assert.deepEqual(store.list(), []),
    );
    withMock(
      fs,
      "rmSync",
      () => {
        throw errno("EACCES");
      },
      () =>
        assert.throws(
          () => store.remove(id(1)),
          /^Error: RUNTIME_STORAGE_FAILED$/,
        ),
    );
    withMock(
      fs,
      "mkdirSync",
      () => {
        throw errno("EACCES");
      },
      () =>
        assert.throws(
          () => new RunStore("secret-path"),
          /^Error: RUNTIME_STORAGE_FAILED$/,
        ),
    );
    assert.equal(store.diagnostics().readFailures, 3);
    assert.equal(store.diagnostics().writeFailures, 2);
  }));

test("save：非法/循环/超大记录不会覆盖上一份有效记录", () =>
  fixture((store, dir) => {
    const original = run(id(1));
    store.save(original);
    const invalid = structuredClone(original);
    invalid.steps = [null];
    assert.throws(() => store.save(invalid), /RUNTIME_INVALID_STATE/);
    const cyclic = structuredClone(original);
    cyclic.plan.steps[0].input.cycle = cyclic;
    assert.throws(() => store.save(cyclic), /RUNTIME_INVALID_STATE/);
    const large = structuredClone(original);
    large.error = "x".repeat(4 * 1024 * 1024);
    assert.throws(() => store.save(large), /RUNTIME_INVALID_STATE/);
    assert.deepEqual(store.load(id(1)), original);
    assert.deepEqual(fs.readdirSync(dir), [id(1) + ".json"]);
  }));
