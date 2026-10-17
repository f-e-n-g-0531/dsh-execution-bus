import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { ExecutionBus } from "../dist/bus.js";

const own = () => ({ sessionId: "prop-session", callId: "call" });
const message = (requestId, input) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId,
  type: "request",
  payload: { handler: "probe", input },
});
const OPTS = {
  concurrency: 2,
  queueLimit: 32,
  recordLimit: 64,
  resultBytes: 4096,
  retentionMs: 60000,
};

test("属性：随机提交/重放序列下每个 requestId 至多执行一次且终态可重取", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({ id: fc.integer({ min: 1, max: 4 }), fail: fc.boolean() }),
        { maxLength: 12 },
      ),
      async (ops) => {
        const bus = new ExecutionBus(OPTS);
        const runs = new Map();
        bus.register("probe", {
          idempotent: true,
          validate() {},
          async run(input, ctx) {
            runs.set(ctx.requestId, (runs.get(ctx.requestId) ?? 0) + 1);
            if (input.fail === true) throw Error("controlled");
            return { id: input.id };
          },
        });
        const attachments = [];
        try {
          for (const op of ops) {
            try {
              attachments.push(
                bus.submit(own(), message("request-" + op.id, { id: op.id, fail: op.fail })),
              );
            } catch (error) {
              assert.match(
                String(error),
                /REQUEST_CONFLICT|BACKPRESSURE|SESSION_BACKPRESSURE|MESSAGE_LIMIT|WAITER_LIMIT/,
              );
            }
          }
          const views = await Promise.all(attachments.map((a) => a.done));
          const allowed = ["succeeded", "failed", "cancelled", "unknown"];
          for (const view of views) assert.ok(allowed.includes(view.state));
          for (const count of runs.values()) assert.equal(count, 1);
          const byRequest = new Map();
          attachments.forEach((attachment, index) => {
            const view = views[index];
            const previous = byRequest.get(view.requestId);
            if (previous === undefined) byRequest.set(view.requestId, view);
            else assert.deepEqual(view, previous);
          });
          assert.ok(bus.diagnostics().records <= OPTS.recordLimit);
        } finally {
          await bus.close();
        }
      },
    ),
    { seed: 20261018, numRuns: 30, timeout: 5000 },
  );
});

test("属性：容量压力下拒绝有界且关闭后无残留状态", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 40 }),
      async (ids) => {
        const bus = new ExecutionBus(OPTS);
        bus.register("probe", {
          idempotent: true,
          validate() {},
          async run() {
            return { ok: true };
          },
        });
        const accepted = [];
        let rejected = 0;
        try {
          ids.forEach((id, index) => {
            try {
              accepted.push(bus.submit(own(), message("cap-" + index + "-" + id, { id })));
            } catch (error) {
              rejected++;
              assert.match(String(error), /BACKPRESSURE|SESSION_BACKPRESSURE|MESSAGE_LIMIT/);
            }
          });
          await Promise.all(accepted.map((a) => a.done));
          const diagnostics = bus.diagnostics();
          assert.equal(accepted.length + rejected, ids.length);
          assert.ok(diagnostics.records <= OPTS.recordLimit);
          assert.equal(diagnostics.running, 0);
        } finally {
          await bus.close();
          assert.equal(bus.diagnostics().records, 0);
          assert.equal(bus.diagnostics().queued, 0);
          assert.equal(bus.diagnostics().running, 0);
        }
      },
    ),
    { seed: 20261018, numRuns: 20, timeout: 5000 },
  );
});
