import { test } from "node:test";
import assert from "node:assert/strict";
import { storageFailureSummary } from "./fixtures/storage-failure.mjs";

test("storage failure diagnostic retains bounded cause codes without private data", () => {
  const cause = Object.assign(Error("private message"), { code: "EPERM", syscall: "rename", path: "private-path", dest: "private-dest" });
  const error = Error("RUNTIME_STORAGE_FAILED", { cause });
  assert.deepEqual(JSON.parse(storageFailureSummary(error)).chain, [
    { code: "unknown", syscall: "unknown" }, { code: "EPERM", syscall: "rename" },
  ]);
  assert.doesNotMatch(storageFailureSummary(error), /private|stack|dest/);
});

test("storage failure diagnostic ignores accessors, arbitrary fields and cyclic causes", () => {
  const error = { code: "private-code", syscall: "private-syscall" };
  Object.defineProperty(error, "cause", { get() { throw Error("must not run"); } });
  assert.deepEqual(JSON.parse(storageFailureSummary(error)).chain, [{ code: "unknown", syscall: "unknown" }]);
  const cycle = { code: "EIO" }; cycle.cause = cycle;
  assert.equal(JSON.parse(storageFailureSummary(cycle)).chain.length, 1);
  let deep = {}; for (let i = 0; i < 10; i++) deep = { cause: deep };
  assert.equal(JSON.parse(storageFailureSummary(deep)).chain.length, 4);
});
