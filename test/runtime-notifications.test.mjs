import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { NotificationStore } from "../dist/runtime/notifications.js";

const owner = "private-owner";
const runId = "run-aaaaaaaa";
const key = "attention-one";
const target = (dir, o = owner, r = runId) =>
  path.join(
    dir,
    createHash("sha256")
      .update(JSON.stringify([o, r]))
      .digest("hex") + ".json",
  );
const fixture = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-notifications-"));
  try {
    return fn(new NotificationStore(dir), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const throws = (fn, code) =>
  assert.throws(fn, (error) => {
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes(owner), false);
    return true;
  });
const withMock = (name, replacement, fn) => {
  const mocked = mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
};

test("receipts: pending / claim / failed / explicit retry / sent lifecycle", () =>
  fixture((store, dir) => {
    assert.equal(store.get(owner, runId), undefined);
    assert.equal(store.sync(owner, runId, key, false), undefined);
    const pending = store.sync(owner, runId, key, true);
    assert.deepEqual(Object.keys(pending).sort(), [
      "attempts",
      "key",
      "revision",
      "runId",
      "status",
      "updatedAt",
    ]);
    assert.equal(pending.revision, 1);
    assert.equal(pending.attempts, 0);
    assert.equal(pending.status, "pending");
    const first = store.claim(owner, runId, key, 1);
    assert.equal(first.revision, 2);
    assert.equal(first.attempts, 1);
    assert.equal(first.status, "delivering");
    const failed = store.settle(
      owner,
      runId,
      key,
      2,
      first.attemptToken,
      "failed",
    );
    assert.equal(failed.revision, 3);
    assert.equal(failed.status, "failed");
    assert.equal(Object.hasOwn(failed, "attemptToken"), false);
    assert.deepEqual(store.sync(owner, runId, key, true), failed);
    const second = new NotificationStore(dir).claim(owner, runId, key, 3);
    assert.equal(second.revision, 4);
    assert.equal(second.attempts, 2);
    assert.notEqual(second.attemptToken, first.attemptToken);
    const sent = store.settle(
      owner,
      runId,
      key,
      4,
      second.attemptToken,
      "sent",
    );
    assert.equal(sent.revision, 5);
    assert.equal(sent.status, "sent");
    assert.equal(Object.hasOwn(sent, "attemptToken"), false);
    assert.deepEqual(new NotificationStore(dir).get(owner, runId), sent);
    assert.deepEqual(store.sync(owner, runId, key, true), sent);
    assert.deepEqual(store.sync(owner, runId, "new-key", false), sent);
    throws(
      () => store.claim(owner, runId, key, sent.revision),
      "RUNTIME_INVALID_STATE",
    );
  }));

test("same-key sync is byte-for-byte idempotent and returned objects cannot mutate storage", () =>
  fixture((store, dir) => {
    const pending = store.sync(owner, runId, key, true);
    const before = fs.readFileSync(target(dir), "utf8");
    assert.deepEqual(store.sync(owner, runId, key, true), pending);
    assert.equal(fs.readFileSync(target(dir), "utf8"), before);
    pending.status = "sent";
    assert.equal(store.get(owner, runId).status, "pending");
    const delivering = store.claim(owner, runId, key, 1);
    assert.deepEqual(store.sync(owner, runId, key, true), delivering);
  }));

test("new keys coalesce one run and fence stale callbacks including ABA keys", () =>
  fixture((store) => {
    store.sync(owner, runId, key, true);
    const first = store.claim(owner, runId, key, 1);
    const replacement = store.sync(owner, runId, "second", true);
    assert.equal(replacement.status, "pending");
    assert.equal(replacement.revision, 3);
    assert.equal(replacement.attempts, 0);
    assert.equal(Object.hasOwn(replacement, "attemptToken"), false);
    throws(
      () =>
        store.settle(
          owner,
          runId,
          key,
          first.revision,
          first.attemptToken,
          "sent",
        ),
      "RUNTIME_RESULT_CHANGED",
    );
    const again = store.sync(owner, runId, key, true);
    assert.equal(again.revision, 4);
    throws(
      () =>
        store.settle(
          owner,
          runId,
          key,
          first.revision,
          first.attemptToken,
          "failed",
        ),
      "RUNTIME_RESULT_CHANGED",
    );
    assert.deepEqual(store.get(owner, runId), again);
  }));

test("withdrawal fences deliveries, is idempotent and does not rearm the same key", () =>
  fixture((store) => {
    store.sync(owner, runId, key, true);
    const attempt = store.claim(owner, runId, key, 1);
    const withdrawn = store.sync(owner, runId, "attention-cleared", false);
    assert.equal(withdrawn.status, "withdrawn");
    assert.equal(withdrawn.revision, 3);
    assert.equal(withdrawn.key, key);
    assert.equal(Object.hasOwn(withdrawn, "attemptToken"), false);
    throws(
      () =>
        store.settle(
          owner,
          runId,
          key,
          attempt.revision,
          attempt.attemptToken,
          "sent",
        ),
      "RUNTIME_RESULT_CHANGED",
    );
    assert.deepEqual(
      store.sync(owner, runId, "cleared-again", false),
      withdrawn,
    );
    assert.deepEqual(store.sync(owner, runId, key, true), withdrawn);
    throws(() => store.claim(owner, runId, key, 3), "RUNTIME_INVALID_STATE");
    assert.equal(store.sync(owner, runId, "fresh", true).revision, 4);
  }));

test("pending and failed notifications can also be withdrawn", () =>
  fixture((store) => {
    store.sync(owner, runId, key, true);
    assert.equal(store.sync(owner, runId, key, false).revision, 2);
    store.sync(owner, runId, "second", true);
    const attempt = store.claim(owner, runId, "second", 3);
    store.settle(owner, runId, "second", 4, attempt.attemptToken, "failed");
    assert.equal(store.sync(owner, runId, "second", false).status, "withdrawn");
  }));

test("owner/run tuples are isolated, hashed and never used as input paths", () =>
  fixture((store, dir) => {
    const owners = [owner, "../other-owner", "a/b", "a"];
    for (const o of owners) store.sync(o, runId, key, true);
    store.sync("a", "b/c", key, true);
    store.sync("a/b", "c", key, true);
    assert.equal(fs.readdirSync(dir).length, 6);
    assert.ok(
      fs.readdirSync(dir).every((name) => /^[0-9a-f]{64}\.json$/.test(name)),
    );
    const attempt = store.claim(owner, runId, key, 1);
    assert.equal(store.get("../other-owner", runId).status, "pending");
    throws(
      () =>
        store.settle(
          "../other-owner",
          runId,
          key,
          attempt.revision,
          attempt.attemptToken,
          "sent",
        ),
      "RUNTIME_RESULT_CHANGED",
    );
    assert.equal(fs.readFileSync(target(dir), "utf8").includes(owner), false);
    assert.equal(store.get("missing", runId), undefined);
    throws(() => store.claim("missing", runId, key, 1), "RUNTIME_NOT_FOUND");
  }));

test("multiple store instances CAS stale revisions and reject wrong tokens", () =>
  fixture((a, dir) => {
    const b = new NotificationStore(dir);
    a.sync(owner, runId, key, true);
    const stale = b.get(owner, runId);
    const attempt = a.claim(owner, runId, key, stale.revision);
    throws(
      () => b.claim(owner, runId, key, stale.revision),
      "RUNTIME_RESULT_CHANGED",
    );
    throws(
      () => b.claim(owner, runId, key, attempt.revision),
      "RUNTIME_INVALID_STATE",
    );
    throws(
      () => b.settle(owner, runId, key, attempt.revision, randomUUID(), "sent"),
      "RUNTIME_RESULT_CHANGED",
    );
    const sent = b.settle(
      owner,
      runId,
      key,
      attempt.revision,
      attempt.attemptToken,
      "sent",
    );
    throws(
      () =>
        a.settle(
          owner,
          runId,
          key,
          attempt.revision,
          attempt.attemptToken,
          "sent",
        ),
      "RUNTIME_RESULT_CHANGED",
    );
    assert.deepEqual(a.get(owner, runId), sent);
  }));

test("exclusive lock rejects concurrent/reentrant writers and crash locks are not stolen", () =>
  fixture((a, dir) => {
    const b = new NotificationStore(dir);
    a.sync(owner, runId, key, true);
    const original = fs.renameSync;
    withMock(
      "renameSync",
      (...args) => {
        throws(() => b.claim(owner, runId, key, 1), "RUNTIME_BUSY");
        return original(...args);
      },
      () => a.claim(owner, runId, key, 1),
    );
    const lock = target(dir) + ".lock";
    fs.writeFileSync(lock, "", { flag: "wx" });
    throws(() => b.sync(owner, runId, "fresh", true), "RUNTIME_BUSY");
    assert.equal(b.get(owner, runId).status, "delivering");
    assert.equal(fs.existsSync(lock), true);
  }));

test("restart leaves delivering unchanged; no implicit retry or delivery", () =>
  fixture((store, dir) => {
    store.sync(owner, runId, key, true);
    const attempt = store.claim(owner, runId, key, 1);
    const restored = new NotificationStore(dir);
    assert.deepEqual(restored.get(owner, runId), attempt);
    assert.deepEqual(restored.sync(owner, runId, key, true), attempt);
    throws(
      () => restored.claim(owner, runId, key, attempt.revision),
      "RUNTIME_INVALID_STATE",
    );
    assert.deepEqual(restored.get(owner, runId), attempt);
    assert.equal(
      restored.sync(owner, runId, "explicit-new-key", true).status,
      "pending",
    );
  }));

test("corrupt/oversized/wrong-shape files fail closed and are never overwritten", () =>
  fixture((store, dir) => {
    const original = store.sync(owner, runId, key, true);
    const badValues = [
      "{",
      "null",
      "[]",
      "x".repeat(32769),
      ...[
        { ...original, owner },
        { ...original, runId: "other" },
        { ...original, revision: 0 },
        { ...original, revision: 1.5 },
        { ...original, revision: Number.MAX_SAFE_INTEGER + 1 },
        { ...original, status: "delivering" },
        { ...original, status: "sent" },
        { ...original, attempts: -1 },
        { ...original, status: "unknown" },
        { ...original, updatedAt: -1 },
        { ...original, attemptToken: randomUUID() },
      ].map((value) => JSON.stringify(value)),
      Buffer.from([0xff]),
    ];
    for (const bad of badValues) {
      fs.writeFileSync(target(dir), bad);
      const before = fs.readFileSync(target(dir));
      throws(() => store.get(owner, runId), "RUNTIME_STORAGE_FAILED");
      throws(
        () => store.sync(owner, runId, "replacement", true),
        "RUNTIME_STORAGE_FAILED",
      );
      throws(() => store.claim(owner, runId, key, 1), "RUNTIME_STORAGE_FAILED");
      assert.deepEqual(fs.readFileSync(target(dir)), before);
      assert.equal(fs.existsSync(target(dir) + ".lock"), false);
    }
  }));

test("storage failures are sanitized and failed atomic replacement preserves old receipt", () =>
  fixture((store, dir) => {
    const original = store.sync(owner, runId, key, true);
    withMock(
      "renameSync",
      () => {
        throw Object.assign(Error(owner + ": secret-token " + dir), {
          code: "EACCES",
        });
      },
      () =>
        throws(
          () => store.claim(owner, runId, key, 1),
          "RUNTIME_STORAGE_FAILED",
        ),
    );
    assert.deepEqual(store.get(owner, runId), original);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(target(dir))]);
    withMock(
      "openSync",
      () => {
        throw Error(owner + " secret-token");
      },
      () => {
        throws(() => store.get(owner, runId), "RUNTIME_STORAGE_FAILED");
        throws(
          () => store.sync(owner, runId, key, true),
          "RUNTIME_STORAGE_FAILED",
        );
      },
    );
  }));

test("invalid inputs and impossible transitions return stable error codes", () =>
  fixture((store) => {
    throws(() => new NotificationStore(""), "INVALID_PLAN");
    for (const bad of ["", null, 12, "bad\0id", "x".repeat(4097), "\ud800"]) {
      throws(() => store.get(bad, runId), "INVALID_PLAN");
      throws(() => store.sync(owner, runId, bad, true), "INVALID_PLAN");
    }
    throws(() => store.sync(owner, runId, key, "yes"), "INVALID_PLAN");
    throws(() => store.claim(owner, runId, key, 0), "INVALID_PLAN");
    store.sync(owner, runId, key, true);
    throws(
      () => store.settle(owner, runId, key, 1, randomUUID(), "sent"),
      "RUNTIME_INVALID_STATE",
    );
    throws(
      () => store.settle(owner, runId, key, 1, "secret-token", "sent"),
      "INVALID_PLAN",
    );
    throws(
      () => store.settle(owner, runId, key, 1, randomUUID(), "unknown"),
      "INVALID_PLAN",
    );
  }));
