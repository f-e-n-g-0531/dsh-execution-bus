import { test } from "node:test";
import { createHash } from "node:crypto";
import { NotificationStore } from "../dist/runtime/notifications.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/plugin.js";
import { RunStore } from "../dist/runtime/store.js";
import { createServiceContext } from "./fixtures/service-context.mjs";

async function fixture(fn) {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-delivery-"));
  const store = new RunStore(root);
  let calls = 0;
  const ctx = createServiceContext(async () => {
    calls++;
    throw Error("PRIVATE_RESULT");
  });
  const service = new RuntimeService(ctx, store);
  const controller = new AbortController();
  const exec = {
    agent: { id: "owner" },
    callId: "delivery",
    signal: controller.signal,
  };
  try {
    const run = await service.run(
      {
        plan: {
          task_id: "audit",
          steps: [
            { id: "r", tool: "read", input: { private: "PRIVATE_INPUT" } },
          ],
        },
      },
      exec,
    );
    await fn({
      root,
      service,
      store,
      ctx,
      exec,
      controller,
      runId: run.runId,
      calls: () => calls,
    });
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

test("host sends once, persists receipt, exposes only fixed action text and no DAG rerun", () =>
  fixture(async (f) => {
    let sends = 0;
    const sender = async (message) => {
      sends++;
      assert.match(message.messageId, /^xiao-he-notification:[a-f0-9]{64}$/);
      assert.match(message.text, /当前行动.*owner/);
      assert.match(message.text, /runtime_result/);
      assert.doesNotMatch(
        JSON.stringify(message),
        /PRIVATE|attemptToken|ownerSessionId/,
      );
      assert.ok(Object.isFrozen(message));
      return "sent";
    };
    const sent = await f.service.deliverNotification(f.runId, f.exec, sender);
    assert.equal(sent.receipt.status, "sent");
    await f.service.deliverNotification(f.runId, f.exec, sender);
    const restored = new RuntimeService(f.ctx, f.store);
    try {
      await restored.deliverNotification(f.runId, f.exec, sender);
    } finally {
      await restored.dispose();
    }
    assert.equal(sends, 1);
    assert.equal(f.calls(), 1);
  }));

for (const outcome of ["unknown", "not_sent", "throw", "invalid"]) {
  test(
    "host leaves uncertain sends fenced and does not implicitly retry: " +
      outcome,
    () =>
      fixture(async (f) => {
        let sends = 0;
        const sender = async () => {
          sends++;
          if (outcome === "throw") throw Error("SECRET_CREDENTIAL");
          return outcome;
        };
        const state = await f.service.deliverNotification(
          f.runId,
          f.exec,
          sender,
        );
        assert.equal(
          state.receipt.status,
          outcome === "not_sent" ? "failed" : "delivering",
        );
        await f.service.deliverNotification(f.runId, f.exec, sender);
        assert.equal(sends, 1);
        assert.equal(f.calls(), 1);
      }),
  );
}

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function unknownProblem(f) {
  const run = f.store.load(f.runId);
  run.steps[0].state = "unknown";
  f.store.save(run);
  return f.service.status({ runId: f.runId }, f.exec).attention;
}

function acknowledgeUnknown(f, attention) {
  return f.service.acknowledge({
    runId: f.runId,
    snapshotHash: attention.snapshotHash,
    expectedRevision: attention.revision,
    key: attention.items[0].key,
    reason: "Received, external state still unknown",
  }, f.exec).attention;
}

for (const outcome of ["sent", "unknown"]) {
  test("acknowledgement keeps the same external-state delivery identity: " + outcome, () =>
    fixture(async (f) => {
      const attention = unknownProblem(f);
      let sends = 0;
      const sender = async () => { sends++; return outcome; };
      const first = await f.service.deliverNotification(f.runId, f.exec, sender);
      assert.equal(first.receipt.status, outcome === "sent" ? "sent" : "delivering");
      assert.equal(first.current.key, digest([digest({ runId: f.runId, items: attention.items }), attention.snapshotHash]));
      const acknowledged = acknowledgeUnknown(f, attention);
      assert.deepEqual(acknowledged.notification, attention.notification);
      assert.equal(acknowledged.items[0].acknowledged, true);
      assert.deepEqual(await f.service.deliverNotification(f.runId, f.exec, sender), first);
      assert.equal(sends, 1);
      assert.equal(f.calls(), 1);
    }));

  test("an already-acknowledged receipt written by the old version is not rearmed: " + outcome, () =>
    fixture(async (f) => {
      const acknowledged = acknowledgeUnknown(f, unknownProblem(f));
      const get = () => f.service.notification({ runId: f.runId }, f.exec);
      const canonical = get().current.key;
      const legacy = digest([digest({ runId: f.runId, items: acknowledged.items }), acknowledged.snapshotHash]);
      assert.notEqual(legacy, canonical);
      const legacyStore = new NotificationStore(path.join(f.root, "notifications"));
      const pending = legacyStore.sync("owner", f.runId, legacy, true);
      const attempt = legacyStore.claim("owner", f.runId, legacy, pending.revision);
      const receipt = outcome === "sent"
        ? legacyStore.settle("owner", f.runId, legacy, attempt.revision, attempt.attemptToken, "sent")
        : attempt;
      const settle = { runId: f.runId, operation: "settle", expectedRevision: attempt.revision,
        attemptToken: attempt.attemptToken, outcome: "sent" };
      assert.equal(get().current.key, legacy);
      assert.deepEqual(get().receipt, receipt);
      let sends = 0;
      const sender = async () => { sends++; return "sent"; };
      const skipped = await f.service.deliverNotification(f.runId, f.exec, sender);
      assert.equal(skipped.current.key, legacy);
      assert.deepEqual(skipped.receipt, receipt);
      assert.equal(sends, 0);
      assert.throws(() => f.service.notification({ ...settle, key: canonical }, f.exec), /RUNTIME_RESULT_CHANGED/);
      if (outcome === "unknown") {
        assert.throws(() => f.service.notification({ ...settle, key: legacy, expectedRevision: pending.revision }, f.exec), /RUNTIME_RESULT_CHANGED/);
        assert.equal(f.service.notification({ ...settle, key: legacy }, f.exec).receipt.status, "sent");
      }
      const changed = f.store.load(f.runId);
      changed.steps[0].error = "new-problem";
      f.store.save(changed);
      const next = f.service.notification({ runId: f.runId, operation: "sync" }, f.exec);
      assert.equal(next.receipt.status, "pending");
      assert.notEqual(next.receipt.key, legacy);
      assert.notEqual(next.receipt.key, canonical);
    }));
}

test("host concurrent delivery claims do not double send", () =>
  fixture(async (f) => {
    let finish;
    let sends = 0;
    const first = f.service.deliverNotification(f.runId, f.exec, async () => {
      sends++;
      return await new Promise((resolve) => {
        finish = resolve;
      });
    });
    const second = await f.service.deliverNotification(
      f.runId,
      f.exec,
      async () => {
        sends++;
        return "sent";
      },
    );
    assert.equal(second.receipt.status, "delivering");
    finish("sent");
    await first;
    assert.equal(sends, 1);
  }));

test("host rejects other owners before sending and respects cancellation", () =>
  fixture(async (f) => {
    let sends = 0;
    const sender = async () => {
      sends++;
      return "sent";
    };
    await assert.rejects(
      f.service.deliverNotification(
        f.runId,
        { ...f.exec, agent: { id: "peer" } },
        sender,
      ),
      /RUNTIME_NOT_FOUND/,
    );
    f.controller.abort();
    await assert.rejects(
      f.service.deliverNotification(f.runId, f.exec, sender),
    );
    assert.equal(sends, 0);
  }));

test("host old callback cannot overwrite a newer notification snapshot", () =>
  fixture(async (f) => {
    let finish;
    const sending = f.service.deliverNotification(
      f.runId,
      f.exec,
      async () =>
        await new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const run = f.store.load(f.runId);
    run.updatedAt++;
    run.error = "RUNTIME_INTERRUPTED";
    run.state = "interrupted";
    run.steps[0].state = "unknown";
    f.store.save(run);
    const newer = f.service.notification(
      { runId: f.runId, operation: "sync" },
      f.exec,
    );
    assert.equal(newer.receipt.status, "pending");
    finish("sent");
    await assert.rejects(sending, /RUNTIME_RESULT_CHANGED/);
    assert.equal(
      f.service.notification({ runId: f.runId }, f.exec).receipt.key,
      newer.receipt.key,
    );
  }));

test("cancellation after transport success preserves uncertain receipt", () =>
  fixture(async (f) => {
    await assert.rejects(
      f.service.deliverNotification(f.runId, f.exec, async () => {
        f.controller.abort();
        return "sent";
      }),
    );
    assert.equal(
      f.service.notification(
        { runId: f.runId },
        { ...f.exec, signal: new AbortController().signal },
      ).receipt.status,
      "delivering",
    );
  }));
