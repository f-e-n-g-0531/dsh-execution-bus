import { test, mock } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
  renameSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";
import { acquireRootLock } from "../dist/runtime/root-lock.js";
import { createServiceContext } from "./fixtures/service-context.mjs";

const service = (root, Store = RunStore) =>
  new RuntimeService(
    createServiceContext(async () => ({})),
    new Store(root),
  );
const lockName = ".runtime-owner.lock";
function child(root, crash = false) {
  const code = `import {RuntimeService} from ${JSON.stringify(new URL("../dist/runtime/service.js", import.meta.url).href)};
    import {RunStore} from ${JSON.stringify(new URL("../dist/runtime/store.js", import.meta.url).href)};
    try { const s = new RuntimeService({}, new RunStore(process.argv[1])); ${crash ? "process.exit(0)" : "await s.dispose()"}; }
    catch(e) { console.error(e.message); process.exitCode=23; }`;
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", code, root],
    { encoding: "utf8", timeout: 10000 },
  );
}

test("same-process services share canonical root ownership until last disposal; second process cannot initialize", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-root-lock-"));
  const first = service(root);
  const second = service(path.join(root, "."));
  try {
    const before = readFileSync(path.join(root, lockName), "utf8");
    const denied = child(root);
    assert.equal(denied.status, 23, denied.stderr);
    assert.equal(denied.stderr.trim(), "RUNTIME_ROOT_LOCKED");
    assert.equal(readFileSync(path.join(root, lockName), "utf8"), before);
    await first.dispose();
    assert.ok(existsSync(path.join(root, lockName)));
    assert.equal(child(root).status, 23);
    await second.dispose();
    assert.equal(existsSync(path.join(root, lockName)), false);
    const allowed = child(root);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(existsSync(path.join(root, lockName)), false);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    rmSync(root, { recursive: true, force: true });
  }
});

test("initialization failure releases a newly acquired root but not a peer owner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-root-failed-"));
  class FailedStore extends RunStore {
    maintain() {
      throw Error("fixture-init-failed");
    }
  }
  try {
    assert.throws(() => service(root, FailedStore), /fixture-init-failed/);
    assert.equal(existsSync(path.join(root, lockName)), false);
    const live = service(root);
    try {
      assert.throws(() => service(root, FailedStore), /fixture-init-failed/);
      assert.equal(child(root).status, 23);
    } finally {
      await live.dispose();
    }
    assert.equal(child(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crashed, old, malformed, and directory locks are never stolen or removed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-root-crash-"));
  const target = path.join(root, lockName);
  try {
    const crashed = child(root, true);
    assert.equal(crashed.status, 0, crashed.stderr);
    const before = readFileSync(target, "utf8");
    utimesSync(target, new Date(0), new Date(0));
    assert.throws(() => service(root), /RUNTIME_ROOT_LOCKED/);
    assert.equal(readFileSync(target, "utf8"), before);
    writeFileSync(target, "malformed");
    assert.throws(() => service(root), /RUNTIME_ROOT_LOCKED/);
    assert.equal(readFileSync(target, "utf8"), "malformed");
    rmSync(target);
    mkdirSync(target);
    assert.throws(() => service(root), /RUNTIME_ROOT_LOCKED/);
    assert.ok(existsSync(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release does not unlink a replacement lock and is idempotent after success", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-root-replaced-"));
  const target = path.join(root, lockName);
  try {
    const release = acquireRootLock(root);
    renameSync(target, target + ".original");
    writeFileSync(target, "replacement");
    assert.throws(release, /RUNTIME_ROOT_LOCKED/);
    assert.equal(readFileSync(target, "utf8"), "replacement");
    rmSync(target);
    renameSync(target + ".original", target);
    release();
    release();
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock acquisition closes descriptors and redacts fstat/write/fsync/close failures", () => {
  for (const operation of [
    "fstatSync",
    "writeFileSync",
    "fsyncSync",
    "closeSync",
  ]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-root-io-"));
    const originalClose = fs.closeSync;
    let closes = 0;
    const closing = mock.method(fs, "closeSync", (fd) => {
      closes++;
      originalClose(fd);
      if (operation === "closeSync") throw Error("private-path");
    });
    const failing =
      operation === "closeSync"
        ? undefined
        : mock.method(fs, operation, () => {
            throw Error("private-path");
          });
    syncBuiltinESMExports();
    try {
      assert.throws(() => acquireRootLock(root), {
        message: "RUNTIME_STORAGE_FAILED",
      });
      assert.equal(closes, 1);
      assert.equal(
        existsSync(path.join(root, lockName)),
        operation === "fstatSync",
      );
    } finally {
      failing?.mock.restore();
      closing.mock.restore();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
