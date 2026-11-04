import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMetadata, selectMetadataPage } from "../dev/metadata-page.mjs";
// Independent oracle matches the current production expression, not the prototype helper.
const oracle = (a, { limit = 20, offset = 0, ownerSessionId } = {}) =>
  [...a]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId))
    .filter(
      (r) =>
        ownerSessionId === undefined || r.ownerSessionId === ownerSessionId,
    )
    .slice(offset, Math.min(Number.MAX_SAFE_INTEGER, offset + limit));
function fixture(size, seed = 42) {
  let n = seed;
  return Array.from({ length: size }, (_, i) => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return Object.freeze({
      runId: "run-" + (i % 37),
      updatedAt: n % 11,
      ownerSessionId: ["a", "b", "c"][n % 3],
      signature: "stamp-" + i,
    });
  });
}
test("metadata comparator matches existing ordering and locale tie-break", () => {
  for (const a of fixture(100))
    for (const b of fixture(40))
      assert.equal(
        compareMetadata(a, b),
        b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId),
      );
});
test("heap and fallback match full sort before owner filtering with stable ties", () => {
  for (const size of [0, 1, 2, 19, 20, 21, 100, 1000])
    for (const seed of [1, 42, 999]) {
      const entries = Object.freeze(fixture(size, seed));
      const snapshot = [...entries];
      for (const ownerSessionId of [undefined, "a", "b", "missing"])
        for (const [offset, limit] of [
          [0, 0],
          [0, 1],
          [0, 20],
          [1, 3],
          [19, 20],
          [100, 20],
          [0, Number.MAX_SAFE_INTEGER],
          [Number.MAX_SAFE_INTEGER, 20],
          [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
        ]) {
          const opts = { ownerSessionId, offset, limit },
            result = selectMetadataPage(entries, opts),
            expected = oracle(entries, opts);
          assert.deepEqual(result.page, expected);
          result.page.forEach((e, i) => assert.equal(e, expected[i]));
          assert.deepEqual(entries, snapshot);
          assert.ok(
            result.peakEntries <=
              Math.min(
                entries.length,
                Math.min(Number.MAX_SAFE_INTEGER, offset + limit),
              ),
          );
        }
    }
});
test("adversarial monotone and equal keys preserve input identity without dropping ties", () => {
  for (const source of [
    fixture(500),
    fixture(500).reverse(),
    fixture(500).sort((a, b) => a.updatedAt - b.updatedAt),
    Array.from({ length: 200 }, (_, i) => ({
      runId: "same",
      updatedAt: 1,
      ownerSessionId: "a",
      i,
    })),
  ]) {
    for (const offset of [0, 10, 120])
      assert.deepEqual(
        selectMetadataPage(source, { limit: 20, offset }).page,
        oracle(source, { limit: 20, offset }),
      );
  }
});
test("invalid offsets and limits cannot allocate heap", () => {
  for (const n of [
    -1,
    0.1,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    "2",
    null,
  ]) {
    assert.throws(() => selectMetadataPage([], { limit: n }), /INVALID_PAGE/);
    assert.throws(() => selectMetadataPage([], { offset: n }), /INVALID_PAGE/);
  }
});
test("small page bounds selector retention but never skips owner scanning", () => {
  const r = selectMetadataPage(fixture(10000), {
    limit: 20,
    offset: 10,
    ownerSessionId: "a",
  });
  assert.equal(r.peakEntries, 30);
  assert.equal(
    r.matched,
    fixture(10000).filter((x) => x.ownerSessionId === "a").length,
  );
  assert.deepEqual(
    r.page,
    oracle(fixture(10000), { limit: 20, offset: 10, ownerSessionId: "a" }),
  );
});
