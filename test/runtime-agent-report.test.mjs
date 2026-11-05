import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseWorkerReport,
  WORKER_REPORT_INSTRUCTIONS,
} from "../dist/runtime/agent-report.js";

const completed = () => ({
  outcome: "completed",
  summary: "Inspection finished",
  evidence: [
    { path: "does-not-exist.ts", lineStart: 1, lineEnd: 2, revision: "abc" },
  ],
  limitations: [],
});
const partial = () => ({
  outcome: "partial",
  summary: "Some work finished",
  evidence: [],
  limitations: ["No independent verification"],
  requestedDecision: "Continue?",
});
const parse = (value) => parseWorkerReport(JSON.stringify(value));
const invalid = (value) =>
  assert.throws(() => parse(value), {
    message: "RUNTIME_AGENT_REPORT_INVALID",
  });

test("accepts every outcome and preserves self-reported text without reading paths", () => {
  for (const value of [
    completed(),
    partial(),
    { ...partial(), outcome: "blocked" },
  ])
    assert.deepEqual(parse(value), value);
  const value = {
    ...completed(),
    summary: "  unchanged  ",
    evidence: [{ path: "../missing/路径" }],
  };
  assert.deepEqual(
    parseWorkerReport(" \n" + JSON.stringify(value) + "\t"),
    value,
  );
  for (const outcome of ["partial", "blocked"]) {
    const value = { ...partial(), outcome, evidence: completed().evidence };
    delete value.requestedDecision;
    assert.deepEqual(parse(value), value);
  }
});

test("requires all four mandatory fields and recognized outcome", () => {
  for (const key of ["outcome", "summary", "evidence", "limitations"]) {
    const value = completed();
    delete value[key];
    invalid(value);
  }
  for (const outcome of ["verified", "done", "", null, 1, [], {}])
    invalid({ ...completed(), outcome });
});

test("enforces outcome-specific evidence, limitations, and decision rules", () => {
  invalid({ ...completed(), evidence: [] });
  for (const requestedDecision of ["Accept?", null, "", 0])
    invalid({ ...completed(), requestedDecision });
  for (const outcome of ["partial", "blocked"])
    invalid({ ...partial(), outcome, limitations: [] });
  assert.deepEqual(
    parse({ ...completed(), limitations: ["Worker claims only"] }).limitations,
    ["Worker claims only"],
  );
});

test("rejects non-object JSON, malformed JSON, fences, prose, and multiple values", () => {
  for (const raw of [
    "",
    " ",
    "null",
    "[]",
    "[{}]",
    '"text"',
    "1",
    "true",
    "false",
    "{",
    "NaN",
    "undefined",
    "\uFEFF" + JSON.stringify(completed()),
    "{} {}",
    JSON.stringify(completed()) + " trailing",
    "Here is the report: " + JSON.stringify(completed()),
    "```json\n" + JSON.stringify(completed()) + "\n```",
    '{"outcome":"completed",}',
  ]) {
    assert.throws(
      () => parseWorkerReport(raw),
      { message: "RUNTIME_AGENT_REPORT_INVALID" },
      raw,
    );
  }
  for (const raw of [null, undefined, 1, {}, []])
    assert.throws(() => parseWorkerReport(raw), {
      message: "RUNTIME_AGENT_REPORT_INVALID",
    });
});

test("rejects unknown and malicious keys at either object level", () => {
  for (const key of [
    "verified",
    "verification",
    "extra",
    "__proto__",
    "constructor",
    "prototype",
  ]) {
    invalid({ ...completed(), [key]: true });
    invalid({ ...completed(), evidence: [{ path: "a", [key]: true }] });
  }
  assert.equal(Object.prototype.verified, undefined);
});

test("rejects incorrect arrays, evidence records, and missing paths", () => {
  for (const evidence of [null, {}, "a", 1, [null], [[]], ["a"], [1], [{}]])
    invalid({ ...completed(), evidence });
  for (const limitations of [null, {}, "a", 1, [null], [[]], [{}], [1]])
    invalid({ ...completed(), limitations });
});

test("text fields reject blank, non-string, and one-character overflow", () => {
  const fields = [
    [4096, (v) => ({ ...completed(), summary: v })],
    [2048, (v) => ({ ...completed(), evidence: [{ path: v }] })],
    [256, (v) => ({ ...completed(), evidence: [{ path: "a", revision: v }] })],
    [1024, (v) => ({ ...partial(), limitations: [v] })],
    [2048, (v) => ({ ...partial(), requestedDecision: v })],
  ];
  for (const [max, make] of fields) {
    assert.doesNotThrow(() => parse(make("a".repeat(max))));
    assert.doesNotThrow(() => parse(make("界".repeat(max))));
    for (const value of [
      "",
      " \t\r\n",
      null,
      false,
      1,
      [],
      {},
      "a".repeat(max + 1),
    ])
      invalid(make(value));
  }
  // Astral characters occupy two UTF-16 code units, not one.
  assert.doesNotThrow(() =>
    parse({ ...completed(), summary: "😀".repeat(2048) }),
  );
  invalid({ ...completed(), summary: "😀".repeat(2049) });
});

test("array bounds include 32 and reject 33", () => {
  assert.equal(
    parse({
      ...completed(),
      evidence: Array.from({ length: 32 }, () => ({ path: "a" })),
    }).evidence.length,
    32,
  );
  invalid({
    ...completed(),
    evidence: Array.from({ length: 33 }, () => ({ path: "a" })),
  });
  assert.equal(
    parse({ ...partial(), limitations: Array(32).fill("a") }).limitations
      .length,
    32,
  );
  invalid({ ...partial(), limitations: Array(33).fill("a") });
});

test("line numbers must be positive safe integers with an ordered dependent end", () => {
  for (const line of [
    0,
    -0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    "1",
    true,
    [],
    {},
  ]) {
    invalid({ ...completed(), evidence: [{ path: "a", lineStart: line }] });
    invalid({
      ...completed(),
      evidence: [{ path: "a", lineStart: 1, lineEnd: line }],
    });
  }
  invalid({ ...completed(), evidence: [{ path: "a", lineEnd: 1 }] });
  invalid({
    ...completed(),
    evidence: [{ path: "a", lineStart: 2, lineEnd: 1 }],
  });
  for (const evidence of [
    [{ path: "a", lineStart: 1 }],
    [{ path: "a", lineStart: 1, lineEnd: 1 }],
    [
      {
        path: "a",
        lineStart: Number.MAX_SAFE_INTEGER,
        lineEnd: Number.MAX_SAFE_INTEGER,
      },
    ],
  ])
    assert.deepEqual(parse({ ...completed(), evidence }).evidence, evidence);
  assert.throws(
    () =>
      parseWorkerReport(
        JSON.stringify(completed()).replace(
          '"lineStart":1',
          '"lineStart":1e999',
        ),
      ),
    { message: "RUNTIME_AGENT_REPORT_INVALID" },
  );
});

test("UTF-8 byte limit includes whitespace, allows exactly 16KiB, and has priority", () => {
  const raw = JSON.stringify(completed());
  const exact = raw + " ".repeat(16_384 - Buffer.byteLength(raw, "utf8"));
  assert.deepEqual(parseWorkerReport(exact), completed());
  assert.throws(() => parseWorkerReport(exact + " "), {
    message: "RUNTIME_AGENT_REPORT_TOO_LARGE",
  });
  const multibyte = JSON.stringify({
    ...completed(),
    summary: "界".repeat(4096),
    evidence: [{ path: "界".repeat(2048) }],
  });
  assert.ok(multibyte.length < 16_384);
  assert.ok(Buffer.byteLength(multibyte, "utf8") > 16_384);
  assert.throws(() => parseWorkerReport(multibyte), {
    message: "RUNTIME_AGENT_REPORT_TOO_LARGE",
  });
  assert.throws(() => parseWorkerReport("x".repeat(16_385)), {
    message: "RUNTIME_AGENT_REPORT_TOO_LARGE",
  });
});

test("worker instructions describe the strict contract and verification boundary", () => {
  assert.equal(typeof WORKER_REPORT_INSTRUCTIONS, "string");
  for (const fragment of [
    "JSON object",
    "completed",
    "partial",
    "blocked",
    "summary",
    "evidence",
    "limitations",
    "requestedDecision",
    "lineStart",
    "lineEnd",
    "revision",
    "4096",
    "2048",
    "256",
    "1024",
    "32",
    "16384",
    "verified",
    "UTF-16",
    "self-reported",
    "not independently verified",
    "does not establish acceptance",
  ])
    assert.ok(WORKER_REPORT_INSTRUCTIONS.includes(fragment), fragment);
});
