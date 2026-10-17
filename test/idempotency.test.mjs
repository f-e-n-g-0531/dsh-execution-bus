import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ExecutionBus } from "../dist/bus.js";

const owner = { sessionId: "s", callId: "c" };
const msg = (id, messageId = randomUUID()) => ({
  protocolVersion: 1,
  messageId,
  requestId: id,
  type: "request",
  payload: { handler: "h", input: {} },
});

test("幂等 handler 终态复用仍返回原结果", async () => {
  const b = new ExecutionBus();
  b.register("h", {
    idempotent: true,
    validate() {},
    async run() {
      return "ok";
    },
  });
  await b.submit(owner, msg("r")).done;
  const c = b.submit(owner, msg("r"));
  assert.equal((await c.done).result, "ok");
  await b.close();
});

test("显式非幂等 handler 的终态复用被拒绝", async () => {
  const b = new ExecutionBus();
  let count = 0;
  b.register("h", {
    idempotent: false,
    validate() {},
    async run() {
      return ++count;
    },
  });
  await b.submit(owner, msg("r")).done;
  assert.equal(count, 1);
  assert.throws(() => b.submit(owner, msg("r")), /MUTATING_REUSE_DENIED/);
  assert.equal(count, 1);
  await b.close();
});

test("未声明 idempotent 的 handler 默认幂等（可复用，向后兼容）", async () => {
  const b = new ExecutionBus();
  b.register("h", {
    validate() {},
    async run() {
      return true;
    },
  });
  await b.submit(owner, msg("r")).done;
  const c = b.submit(owner, msg("r"));
  assert.equal((await c.done).result, true);
  await b.close();
});

test("非幂等 handler 运行中的重复 attach 仍成功且只执行一次", async () => {
  const b = new ExecutionBus();
  let count = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  b.register("h", {
    idempotent: false,
    validate() {},
    async run() {
      count++;
      await gate;
      return "done";
    },
  });
  const a = b.submit(owner, msg("r"));
  await Promise.resolve();
  const c = b.submit(owner, msg("r"));
  release();
  assert.equal((await a.done).state, "succeeded");
  assert.equal((await c.done).state, "succeeded");
  assert.equal(count, 1);
  await b.close();
});
