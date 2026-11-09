import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";
import { HistoryPages } from "../dist/runtime/history.js";
import { createServiceContext } from "./fixtures/service-context.mjs";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";
const exec = (id = "owner") => ({
  agent: { id },
  callId: "history",
  signal: new AbortController().signal,
});
const plan = {
  task_id: "audit",
  steps: [{ id: "read", tool: "read", input: {} }],
};
test("snapshots retain membership across update/insert, report missing records, and isolate scopes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-history-"));
  const store = new RunStore(root);
  const service = new RuntimeService(
    createServiceContext(async () => "ok"),
    store,
  );
  try {
    const ids = [];
    for (let i = 0; i < 4; i++)
      ids.push((await service.run({ plan }, exec())).runId);
    const tie = store.load(ids[1]);
    const tied = store.load(ids[0]);
    tied.updatedAt = tie.updatedAt;
    tied.finishedAt = tie.finishedAt;
    store.save(tied);
    const ordered = service
      .task({ taskId: "audit" }, exec())
      .runs.map((r) => r.runId);
    const first = service.task(
      { taskId: "audit", snapshot: true, limit: 1 },
      exec(),
    );
    assert.equal(first.pagination.total, 4);
    assert.deepEqual(
      first.runs.map((r) => r.runId),
      ordered.slice(0, 1),
    );
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_task, first),
      [],
    );
    const changed = store.load(ordered[3]);
    changed.updatedAt += 100;
    changed.finishedAt = changed.updatedAt;
    store.save(changed);
    const inserted = await service.run({ plan }, exec());
    store.remove(ordered[1]);
    const missing = service.task(
      { taskId: "audit", cursor: first.pagination.nextCursor, limit: 1 },
      exec(),
    );
    assert.equal(missing.runs.length, 0);
    assert.equal(missing.hasMore, true);
    assert.deepEqual(missing.pagination.missingRunIds, [ordered[1]]);
    assert.match(runtimePresentationMeta({}, missing).text, /本页无可读取运行/);
    assert.doesNotMatch(
      runtimePresentationMeta({}, missing).text,
      /本会话暂无运行/,
    );
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_task, missing),
      [],
    );
    const rest = service.task(
      { taskId: "audit", cursor: first.pagination.nextCursor, limit: 100 },
      exec(),
    );
    assert.deepEqual(
      rest.runs.map((r) => r.runId),
      ordered.slice(2),
    );
    assert.deepEqual(rest.pagination.missingRunIds, [ordered[1]]);
    assert.equal(
      rest.runs.find((r) => r.runId === changed.runId).updatedAt,
      changed.updatedAt,
    );
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_task, rest),
      [],
    );
    assert.equal(
      rest.runs.some((r) => r.runId === inserted.runId),
      false,
    );
    assert.match(runtimePresentationMeta({}, rest).text, /缺失项/);
    assert.throws(
      () =>
        service.task(
          { taskId: "other", cursor: first.pagination.nextCursor },
          exec(),
        ),
      /RUNTIME_NOT_FOUND/,
    );
    assert.throws(
      () =>
        service.task(
          { taskId: "audit", cursor: first.pagination.nextCursor },
          exec("peer"),
        ),
      /RUNTIME_NOT_FOUND/,
    );
    const all = service.status({ snapshot: true, limit: 1 }, exec());
    assert.throws(
      () =>
        service.task(
          { taskId: "audit", cursor: all.pagination.nextCursor },
          exec(),
        ),
      /RUNTIME_NOT_FOUND/,
    );
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_status, all),
      [],
    );
    assert.throws(
      () =>
        service.status(
          { cursor: all.pagination.nextCursor, offset: 0 },
          exec(),
        ),
      /INVALID_PLAN/,
    );
    assert.throws(
      () => service.status({ runId: ids[0], snapshot: true }, exec()),
      /INVALID_PLAN/,
    );
    assert.throws(
      () => service.status({ snapshot: false }, exec()),
      /INVALID_PLAN/,
    );
    assert.throws(
      () =>
        service.status(
          { cursor: all.pagination.nextCursor, snapshot: true },
          exec(),
        ),
      /INVALID_PLAN/,
    );
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
test("snapshot cursors do not survive disposal or service recreation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-history-restart-"));
  const store = new RunStore(root);
  let service = new RuntimeService(
    createServiceContext(async () => "ok"),
    store,
  );
  try {
    await service.run({ plan }, exec());
    await service.run({ plan }, exec());
    const first = service.status({ snapshot: true, limit: 1 }, exec());
    await service.dispose();
    service = new RuntimeService(
      createServiceContext(async () => "ok"),
      store,
    );
    assert.throws(
      () => service.status({ cursor: first.pagination.nextCursor }, exec()),
      /RUNTIME_NOT_FOUND/,
    );
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
test("snapshot expiration, eviction and bounds fail closed", () => {
  const pages = new HistoryPages();
  const original = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const first = pages.page(
      "owner",
      undefined,
      { snapshot: true, limit: 1 },
      () => ["a", "b"],
    );
    now += 300000;
    assert.throws(
      () =>
        pages.page(
          "owner",
          undefined,
          { cursor: first.pagination.nextCursor },
          () => [],
        ),
      /RUNTIME_NOT_FOUND/,
    );
    const evicted = pages.page(
      "owner",
      undefined,
      { snapshot: true, limit: 1 },
      () => ["a", "b"],
    );
    for (let i = 0; i < 16; i++)
      pages.page("owner", undefined, { snapshot: true }, () => []);
    assert.throws(
      () =>
        pages.page(
          "owner",
          undefined,
          { cursor: evicted.pagination.nextCursor },
          () => [],
        ),
      /RUNTIME_NOT_FOUND/,
    );
    assert.throws(
      () =>
        pages.page("owner", undefined, { snapshot: true }, () =>
          Array(1001).fill("a"),
        ),
      /RUNTIME_INVALID_STATE/,
    );
    pages.clear();
  } finally {
    Date.now = original;
  }
});
