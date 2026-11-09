import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelWaitObserver } from "../dist/runtime/model-wait.js";

const event = (type, seq, data, time = 1000 + seq) => ({
  type,
  seq,
  time,
  data,
});
const retry = (seq, overrides = {}) =>
  event("llm/retry", seq, {
    turn: 1,
    step: 2,
    retryId: "chain-a",
    provider: "provider-a",
    retry: 1,
    delayMs: 100,
    failure: { code: "BUDGET_EXCEEDED", message: "secret" },
    ...overrides,
  });
const output = (seq, overrides = {}) =>
  event("assistant/message", seq, {
    turn: 1,
    step: 2,
    message: { source: { kind: "model", provider: "provider-a" } },
    ...overrides,
  });

test("projects only safe metadata, returns copies, and does not mutate events", () => {
  const observer = new ModelWaitObserver();
  const input = retry(1);
  const before = structuredClone(input);
  observer.observe(input);
  assert.deepEqual(observer.get(), {
    provider: "provider-a",
    reason: "budget",
    attempts: 1,
    since: 1001,
    lastAt: 1001,
    nextRetryAt: 1101,
  });
  observer.get().attempts = 999;
  assert.equal(observer.get().attempts, 1);
  assert.deepEqual(input, before);
  assert.doesNotMatch(
    JSON.stringify(observer.get()),
    /secret|failure|chain-a|policy/,
  );
});

test("classifies structured failure facts, never message bodies", () => {
  for (const [failure, reason] of [
    [{ type: "budget_exceeded" }, "budget"],
    [{ code: "INSUFFICIENT_QUOTA" }, "budget"],
    [{ code: "RATE_LIMIT" }, "rate_limit"],
    [{ status: 429, code: "BUDGET_EXCEEDED" }, "rate_limit"],
    [{ status: 403, type: "budget_exceeded" }, "authentication"],
    [{ code: "CONTEXT_LENGTH_EXCEEDED" }, "context_limit"],
    [{ status: 503 }, "transient"],
    [{ code: "NEW_PROVIDER_CODE" }, "other"],
    [
      { code: "INVALID_REQUEST", message: '{"type":"budget_exceeded"}' },
      "other",
    ],
  ]) {
    const observer = new ModelWaitObserver();
    observer.observe(retry(1, { failure }));
    assert.equal(observer.get()?.reason, reason);
  }
  const observer = new ModelWaitObserver();
  observer.observe(
    retry(1, {
      failure: {
        get message() {
          throw Error("must not read");
        },
      },
    }),
  );
  assert.equal(observer.get(), undefined);
});

test("retry-started and interrupted or wrong-provider output are not recovery", () => {
  const observer = new ModelWaitObserver();
  observer.observe(retry(1));
  observer.observe(
    event("llm/retry-started", 2, {
      turn: 1,
      step: 2,
      retryId: "chain-a",
      retry: 1,
    }),
  );
  observer.observe(output(3, { interrupted: true }));
  observer.observe(
    output(4, { message: { source: { kind: "model", provider: "other" } } }),
  );
  observer.observe(
    output(5, {
      message: { source: { kind: "synthetic", provider: "provider-a" } },
    }),
  );
  observer.observe(event("assistant/attempt", 6, { turn: 1, step: 2 }));
  assert.equal(observer.get()?.attempts, 1);
  observer.observe(output(7));
  assert.equal(observer.get(), undefined);
  observer.observe(retry(8, { retry: 2 }));
  assert.equal(observer.get(), undefined);
});

test("sequence, turn, step and retry watermarks reject stale observations", () => {
  const observer = new ModelWaitObserver();
  observer.observe(retry(10, { step: 3, retry: 2 }));
  observer.observe(retry(10, { step: 3, retry: 100 }));
  observer.observe(output(9, { step: 3 }));
  observer.observe(output(11));
  observer.observe(retry(12, { turn: 0, step: 9, retry: 100 }));
  observer.observe(retry(13, { step: 3, retry: 1 }));
  observer.observe(event("turn/end", 14, { turn: 0 }));
  assert.equal(observer.get()?.attempts, 2);
  assert.equal(observer.get()?.lastAt, 1010);
  observer.observe(output(15, { step: 3 }));
  assert.equal(observer.get(), undefined);
});

test("provider and chain changes reset timing, retired chains cannot replace current", () => {
  const observer = new ModelWaitObserver();
  observer.observe(retry(1));
  observer.observe(retry(2, { retry: 2 }));
  assert.equal(observer.get().since, 1001);
  observer.observe(retry(3, { provider: "fallback", retryId: "chain-b" }));
  observer.observe(retry(4, { retry: 3 }));
  observer.observe(output(5));
  assert.equal(observer.get().provider, "fallback");
  assert.equal(observer.get().since, 1003);
  observer.observe(
    output(6, { message: { source: { kind: "model", provider: "fallback" } } }),
  );
  assert.equal(observer.get(), undefined);
});

test("clear and turn end seal current lifecycle; a new step or turn opens another", () => {
  const observer = new ModelWaitObserver();
  observer.observe(retry(1));
  observer.clear();
  observer.observe(retry(2, { retry: 2 }));
  assert.equal(observer.get(), undefined);
  observer.observe(event("step/start", 3, { turn: 1, step: 3 }));
  observer.observe(retry(4, { step: 3 }));
  assert.equal(observer.get()?.attempts, 1);
  observer.observe(
    event("turn/end", 5, { turn: 1, reason: { kind: "aborted" } }),
  );
  observer.observe(event("turn/start", 6, { turn: 1 }));
  observer.observe(retry(7, { step: 4 }));
  assert.equal(observer.get(), undefined);
  observer.observe(retry(8, { turn: 2 }));
  assert.equal(observer.get()?.since, 1008);
});

test("rejects invalid identities, ordinals and timestamps without advancing lifecycle", () => {
  for (const overrides of [
    { retry: NaN },
    { retry: Infinity },
    { retry: 0 },
    { retry: 1.5 },
    { retry: Number.MAX_SAFE_INTEGER + 1 },
    { retryId: "" },
    { provider: "" },
    { turn: -1 },
    { step: 0.5 },
  ]) {
    const observer = new ModelWaitObserver();
    observer.observe(retry(1, overrides));
    assert.equal(observer.get(), undefined);
  }
  const observer = new ModelWaitObserver();
  for (const time of [NaN, Infinity, -1, 8.64e15 + 1])
    observer.observe({ ...retry(100), time });
  observer.observe(retry(1));
  observer.observe(retry(2, { turn: 100, retryId: "" }));
  observer.observe(retry(3, { retry: 2, delayMs: Infinity }));
  assert.equal(observer.get()?.attempts, 2);
  assert.equal(observer.get()?.nextRetryAt, undefined);
});

test("does not infer waits from quoted content or unscheduled failures", () => {
  const observer = new ModelWaitObserver();
  for (const type of [
    "user/message",
    "assistant/attempt",
    "tool/result",
    "unknown",
  ])
    observer.observe(
      event(type, 1, {
        turn: 1,
        step: 2,
        failure: { code: "BUDGET_EXCEEDED" },
      }),
    );
  assert.equal(observer.get(), undefined);
  observer.observe(retry(2, { provider: "unsafe provider secret" }));
  assert.equal(observer.get()?.provider, "unknown");
  observer.observe(
    retry(3, { provider: "unsafe provider secret", retry: 2, failure: null }),
  );
  assert.equal(observer.get(), undefined);
});
