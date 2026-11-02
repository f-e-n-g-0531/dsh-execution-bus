import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";

const id = (n) => "run-" + n.toString(36).padStart(8, "0");
function record(n, owner = "owner", state = "running") {
  return {
    version: 1,
    runId: id(n),
    ownerSessionId: owner,
    plan: parsePlan({ steps: [{ id: "a", tool: "read", input: {} }] }),
    state,
    steps: [{ id: "a", tool: "read", state: "pending", attempts: 0 }],
    results: {},
    createdAt: 1,
    updatedAt: 10,
    ...(state === "running" ? {} : { finishedAt: 10 }),
  };
}
function intercept(name, replacement, fn) {
  const entry = mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    entry.mock.restore();
    syncBuiltinESMExports();
  }
}
function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-cache-"));
  try {
    return fn(new RunStore(root), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Deterministic descriptor-level filesystem. Identity/times change explicitly,
// without sleeps, platform-specific timestamp resolution or huge on-disk fixtures.
function virtual(fn) {
  return fixture((store, root) => {
    const files = new Map();
    const descriptors = new Map();
    const readCounts = new Map();
    const handles = [];
    let sequence = 1n;
    let nextFd = 100000;
    let fstats = 0;
    const put = (run, options = {}) => {
      const key = run.runId;
      const old = files.get(key);
      const text = typeof run === "object" ? JSON.stringify(run) : run;
      const item = {
        text,
        ino: old?.ino ?? sequence++,
        mtimeNs: sequence++,
        ctimeNs: sequence++,
        birthtimeNs: old?.birthtimeNs ?? sequence++,
        ...options,
      };
      files.set(key, item);
      return item;
    };
    const install = (name, replacement) => {
      handles.push(mock.method(fs, name, replacement));
    };
    const actualOpen = fs.openSync;
    const actualClose = fs.closeSync;
    const actualRead = fs.readSync;
    const actualFstat = fs.fstatSync;
    const actualReaddir = fs.readdirSync;
    install("openSync", (target, flags, ...args) => {
      if (
        typeof target !== "string" ||
        !target.startsWith(root) ||
        flags !== "r"
      )
        return actualOpen(target, flags, ...args);
      const key = path.basename(target, ".json");
      const file = files.get(key);
      if (!file) throw Object.assign(Error("not found"), { code: "ENOENT" });
      const fd = nextFd++;
      descriptors.set(fd, { key, file, offset: 0 });
      return fd;
    });
    install("fstatSync", (fd, options) => {
      const entry = descriptors.get(fd);
      if (!entry) return actualFstat(fd, options);
      fstats++;
      assert.equal(options?.bigint, true);
      const file = entry.file;
      return {
        isFile: () => true,
        dev: 1n,
        ino: file.ino,
        size: BigInt(Buffer.byteLength(file.text)),
        mtimeNs: file.mtimeNs,
        ctimeNs: file.ctimeNs,
        birthtimeNs: file.birthtimeNs,
      };
    });
    install("readSync", (fd, buffer, offset, length, position) => {
      const entry = descriptors.get(fd);
      if (!entry) return actualRead(fd, buffer, offset, length, position);
      readCounts.set(entry.key, (readCounts.get(entry.key) ?? 0) + 1);
      const bytes = Buffer.from(entry.file.text);
      const count = Math.min(length, bytes.length - entry.offset);
      bytes.copy(buffer, offset, entry.offset, entry.offset + count);
      entry.offset += count;
      return count;
    });
    install("closeSync", (fd) => {
      if (!descriptors.delete(fd)) return actualClose(fd);
    });
    install("readdirSync", (target, ...args) =>
      target === root
        ? [...files.keys()].map((key) => key + ".json")
        : actualReaddir(target, ...args),
    );
    syncBuiltinESMExports();
    try {
      return fn({
        store,
        files,
        put,
        readCounts,
        get fstats() {
          return fstats;
        },
      });
    } finally {
      for (const entry of handles.reverse()) entry.mock.restore();
      syncBuiltinESMExports();
      assert.equal(descriptors.size, 0);
    }
  });
}

test("warm metadata scans skip payload reads, but selected page and public load always read", () =>
  virtual((v) => {
    for (let n = 1; n <= 40; n++) v.put(record(n));
    assert.equal(v.store.list(0).length, 0);
    assert.equal(v.readCounts.size, 40);
    v.readCounts.clear();
    const before = v.fstats;
    assert.equal(v.store.list(2).length, 2);
    assert.equal(v.readCounts.size, 2);
    assert.ok(v.fstats - before >= 84); // stat before/after every hit + selected reads.
    v.readCounts.clear();
    assert.ok(v.store.load(id(30)));
    assert.ok(v.readCounts.has(id(30)));
  }));

test("same-size owner rewrite with restored mtime invalidates metadata via nanosecond ctime", () =>
  virtual((v) => {
    const first = record(1, "owner");
    const cached = v.put(first);
    v.store.list(0);
    const changed = record(1, "other");
    assert.equal(JSON.stringify(first).length, JSON.stringify(changed).length);
    v.put(changed, { mtimeNs: cached.mtimeNs, ctimeNs: cached.ctimeNs + 1n });
    assert.deepEqual(v.store.list(10, "owner"), []);
    assert.equal(v.store.list(10, "other")[0].ownerSessionId, "other");
    assert.equal(v.store.load(id(1)).ownerSessionId, "other");
  }));

test("inode-only replacement invalidates hints even with identical size and all timestamps", () =>
  virtual((v) => {
    const cached = v.put(record(1, "owner"));
    v.store.list(0);
    v.put(record(1, "other"), {
      ...cached,
      text: JSON.stringify(record(1, "other")),
      ino: cached.ino + 1n,
    });
    assert.deepEqual(v.store.list(10, "owner"), []);
    assert.equal(v.store.list(10, "other").length, 1);
  }));

test("corruption and missing files never return cached metadata as raw records", () =>
  virtual((v) => {
    const cached = v.put(record(1));
    v.store.list(0);
    cached.text = "!" + cached.text.slice(1); // Same size and even unchanged signature.
    assert.equal(v.store.load(id(1)), undefined); // Full read is always authoritative.
    assert.deepEqual(v.store.list(1), []); // Selected page must be fully validated.
    v.files.delete(id(1));
    assert.equal(v.store.load(id(1)), undefined);
    assert.deepEqual(v.store.list(1), []);
  }));

test("list reselects changed owner page and never returns cached mutable references", () =>
  virtual((v) => {
    v.put(record(1));
    v.put(record(2));
    v.store.list(0);
    const actualRead = fs.readSync;
    let once = false;
    intercept(
      "readSync",
      (...args) => {
        if (!once) {
          once = true;
          const file = v.files.get(id(1));
          file.text = JSON.stringify(record(1, "other"));
          file.ctimeNs++;
        }
        return actualRead(...args);
      },
      () => {
        const page = v.store.list(1, "owner");
        assert.equal(page[0].runId, id(2));
      },
    );
    const selected = v.store.list(1, "owner")[0];
    selected.ownerSessionId = "mutated";
    selected.plan.steps[0].input.secret = "mutated";
    assert.equal(v.store.load(id(2)).ownerSessionId, "owner");
    assert.equal(
      v.store.list(1, "owner")[0].plan.steps[0].input.secret,
      undefined,
    );
  }));

test("same-signature owner and rank hints cannot authorize or order a returned page", () =>
  virtual((v) => {
    const a = v.put(record(1));
    v.put(record(2));
    v.store.list(0);
    // Deliberately emulate an adversarial filesystem with identical stat values.
    a.text = JSON.stringify(record(1, "other"));
    assert.equal(v.store.list(1, "owner")[0].runId, id(2));
    const second = v.files.get(id(2));
    second.text = JSON.stringify({ ...record(2), updatedAt: 11 });
    assert.equal(v.store.list(1, "owner")[0].updatedAt, 11);
  }));

test("a page that changes in both bounded selection attempts returns no stale page", () =>
  virtual((v) => {
    const one = v.put(record(1));
    v.store.list(0);
    const actualRead = fs.readSync;
    let call = 0;
    intercept(
      "readSync",
      (...args) => {
        if (call++ % 2 === 0) {
          one.text = JSON.stringify({ ...record(1), updatedAt: 10 + call });
          one.ctimeNs++;
        }
        return actualRead(...args);
      },
      () => assert.deepEqual(v.store.list(1), []),
    );
  }));

test("descriptor changes during a read are rejected rather than cached", () =>
  virtual((v) => {
    v.put(record(1));
    const actualRead = fs.readSync;
    intercept(
      "readSync",
      (...args) => {
        const result = actualRead(...args);
        v.files.get(id(1)).ctimeNs++;
        return result;
      },
      () => assert.equal(v.store.load(id(1)), undefined),
    );
    assert.equal(v.store.diagnostics().invalidRecords, 1);
    assert.ok(v.store.load(id(1)));
  }));

test("metadata byte budget is shared and bounded; oversized populations evict oldest hints", () =>
  virtual((v) => {
    // >4 MiB of owner strings alone, irrespective of root length or engine overhead.
    for (let n = 1; n <= 5000; n++) v.put(record(n, "o".repeat(1024)));
    v.store.list(0);
    v.readCounts.clear();
    // Restrict enumeration to the oldest entry to inspect eviction, not refill LRU.
    const actualReaddir = fs.readdirSync;
    intercept(
      "readdirSync",
      (target, ...args) =>
        target === v.store.root
          ? [id(1) + ".json"]
          : actualReaddir(target, ...args),
      () => v.store.list(0),
    );
    assert.ok(v.readCounts.has(id(1)));
    assert.equal(v.store.diagnostics().readFailures, 0);
  }));

test("warm ten-thousand small candidates fit metadata budget without scan thrashing", () =>
  virtual((v) => {
    for (let n = 1; n <= 10000; n++) v.put(record(n));
    v.store.list(0);
    v.readCounts.clear();
    v.store.list(0);
    assert.equal(v.readCounts.size, 0);
  }));

test("atomic save and remove invalidate warmed metadata across store instances", () =>
  fixture((store, root) => {
    const second = new RunStore(root);
    store.save(record(1));
    store.list(0);
    second.save(record(1, "other"));
    assert.deepEqual(store.list(10, "owner"), []);
    assert.equal(store.list(10, "other")[0].ownerSessionId, "other");
    second.remove(id(1));
    assert.deepEqual(store.list(), []);
  }));

test("prune within retention budget reads each payload once without unused boundary validation", () =>
  virtual(({ store, put, readCounts }) => {
    for (let n = 0; n < 100; n++) put(record(n, "owner", "failed"));
    store.prune(100);
    // The virtual read counts include one EOF probe per full read.
    assert.equal(
      [...readCounts.values()].reduce((sum, n) => sum + n, 0),
      200,
    );
  }));

test("prune fully revalidates terminal candidates and retained boundary without quadratic reads", () =>
  fixture((store) => {
    for (let n = 1; n <= 110; n++) store.save(record(n, "owner", "failed"));
    store.save(record(111));
    store.save(record(112, "owner", "interrupted"));
    const actualRead = fs.readSync;
    let reads = 0;
    intercept(
      "readSync",
      (...args) => {
        reads++;
        return actualRead(...args);
      },
      () => store.prune(100),
    );
    assert.ok(reads <= 500, "one scan + single boundary pass + candidate pass");
    assert.equal(store.list(1000).length, 102);
    assert.equal(store.load(id(111)).state, "running");
    assert.equal(store.load(id(112)).state, "interrupted");
  }));

test("prune stops if a terminal deletion candidate becomes recoverable after scanning", () =>
  fixture((store) => {
    store.save(record(1, "owner", "failed"));
    store.save(record(2, "owner", "failed"));
    const actualOpen = fs.openSync;
    const opens = new Map();
    intercept(
      "openSync",
      (target, flags, ...args) => {
        if (flags === "r") {
          const count = (opens.get(target) ?? 0) + 1;
          opens.set(target, count);
          if (target === store.pathFor(id(2)) && count === 2)
            fs.writeFileSync(
              target,
              JSON.stringify(record(2, "owner", "interrupted")),
            );
        }
        return actualOpen(target, flags, ...args);
      },
      () => store.prune(1),
    );
    assert.equal(store.load(id(1)).state, "failed");
    assert.equal(store.load(id(2)).state, "interrupted");
  }));

test("prune stops on a changed retained boundary instead of trusting the old rank", () =>
  fixture((store) => {
    store.save(record(1, "owner", "failed"));
    store.save(record(2, "owner", "failed"));
    const actualOpen = fs.openSync;
    let opens = 0;
    intercept(
      "openSync",
      (target, flags, ...args) => {
        if (flags === "r" && target === store.pathFor(id(1)) && ++opens === 2)
          fs.writeFileSync(
            target,
            JSON.stringify(record(1, "owner", "running")),
          );
        return actualOpen(target, flags, ...args);
      },
      () => store.prune(1),
    );
    assert.equal(store.load(id(1)).state, "running");
    assert.equal(store.load(id(2)).state, "failed");
  }));

test("markInterrupted fresh reads skip a newly completed record rather than overwriting it", () =>
  fixture((store) => {
    store.save(record(1));
    const actualOpen = fs.openSync;
    let opens = 0;
    intercept(
      "openSync",
      (target, flags, ...args) => {
        if (flags === "r" && target === store.pathFor(id(1)) && ++opens === 2)
          fs.writeFileSync(
            target,
            JSON.stringify(record(1, "owner", "failed")),
          );
        return actualOpen(target, flags, ...args);
      },
      () => assert.equal(store.markInterrupted(), 0),
    );
    assert.equal(store.load(id(1)).state, "failed");
  }));

test("maintain enumerates once, preserves exclusions and terminal retention, and propagates write failure", () =>
  fixture((store) => {
    store.save(record(1));
    store.save(record(2));
    store.save(record(3, "owner", "failed"));
    store.save(record(4, "owner", "failed"));
    const actualReaddir = fs.readdirSync;
    let scans = 0;
    const recovered = intercept(
      "readdirSync",
      (...args) => {
        scans++;
        return actualReaddir(...args);
      },
      () => store.maintain(new Set([id(2)]), 1),
    );
    assert.equal(scans, 1);
    assert.equal(recovered, 1);
    assert.equal(store.load(id(1)).state, "interrupted");
    assert.equal(store.load(id(2)).state, "running");
    assert.equal(store.load(id(4)), undefined); // Stable runId tie ordering.
    assert.equal(store.load(id(3)).state, "failed");
    store.save(record(5, "owner", "failed"));
    intercept(
      "renameSync",
      () => {
        throw Error("private error");
      },
      () => {
        assert.throws(
          () => store.maintain(new Set(), 0),
          /^Error: RUNTIME_STORAGE_FAILED$/,
        );
      },
    );
    assert.equal(store.load(id(5)).state, "failed"); // Recovery write failure stops pruning.
    assert.equal(store.load(id(2)).state, "running");
    assert.throws(() => store.maintain(new Set(), -1), /RUNTIME_INVALID_STATE/);
  }));
