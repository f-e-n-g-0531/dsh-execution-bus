import { test } from "node:test";
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
