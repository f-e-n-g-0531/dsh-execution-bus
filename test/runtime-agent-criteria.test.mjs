import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentInput, workerInstructions } from "../dist/runtime/agent.js";
import {
  parseWorkerReport,
  WORKER_REPORT_INSTRUCTIONS,
} from "../dist/runtime/agent-report.js";
import {
  promptHash,
  WORKER_ROLE_INSTRUCTIONS,
} from "../dist/runtime/agent-trace.js";

const contract = () => [
  { id: "C1", description: "Inspect the parser" },
  { id: "C2", description: "Check errors" },
];
const input = (acceptance_criteria = contract()) => ({
  prompt: "  inspect  ",
  output_format: "report",
  acceptance_criteria,
});
const report = () => ({
  outcome: "completed",
  summary: "Inspected",
  evidence: [{ path: "missing.ts" }],
  limitations: [],
  criteria: [
    {
      id: "C1",
      status: "observed",
      evidence_indices: [0],
      note: "Parser inspected",
    },
    {
      id: "C2",
      status: "not_verified",
      evidence_indices: [],
      note: "Not executed",
    },
  ],
});
const parse = (value, criteria = contract()) =>
  parseWorkerReport(JSON.stringify(value), criteria);
const invalidInput = (value) =>
  assert.throws(() => parseAgentInput(value), {
    message: "RUNTIME_AGENT_INVALID_INPUT",
  });
const invalidReport = (value) =>
  assert.throws(() => parse(value), {
    message: "RUNTIME_AGENT_REPORT_INVALID",
  });

test("optional input preserves defaults, exact prompt and canonical JSON roundtrip", () => {
  const legacy = parseAgentInput({ prompt: "inspect" });
  assert.deepEqual(legacy, {
    prompt: "inspect",
    access: "read",
    write_scopes: [],
    max_steps: 12,
  });
  assert.equal(Object.hasOwn(legacy, "acceptance_criteria"), false);
  const parsed = parseAgentInput(input());
  assert.equal(parsed.prompt, "  inspect  ");
  assert.deepEqual(parsed.acceptance_criteria, contract());
  assert.deepEqual(parseAgentInput(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.deepEqual(
    parseAgentInput({ ...input(), acceptance_criteria: undefined }),
    parseAgentInput({ prompt: "  inspect  ", output_format: "report" }),
  );
});

test("criteria requires report, bounded unique ASCII identifiers and nonblank descriptions", () => {
  for (const output_format of [undefined, "text"])
    invalidInput({ ...input(), output_format });
  for (const criteria of [
    null,
    {},
    [],
    Array.from({ length: 17 }, (_, i) => ({ id: "C" + i, description: "d" })),
    [contract()[0], contract()[0]],
  ])
    invalidInput(input(criteria));
  for (const id of ["", "1A", "A B", "é", "A\n", "a".repeat(65)])
    invalidInput(input([{ id, description: "d" }]));
  for (const description of ["", " ", null, 1, "d".repeat(1025)])
    invalidInput(input([{ id: "A", description }]));
  assert.equal(
    parseAgentInput(
      input([{ id: "A" + "_".repeat(63), description: "d".repeat(1024) }]),
    ).acceptance_criteria.length,
    1,
  );
  assert.equal(
    parseAgentInput(
      input(
        Array.from({ length: 16 }, (_, i) => ({
          id: "C" + i,
          description: "d",
        })),
      ),
    ).acceptance_criteria.length,
    16,
  );
});

test("rejects criterion unknown fields, prototypes, sparse arrays and accessors without invoking them", () => {
  let reads = 0;
  const getter = {
    get id() {
      reads++;
      return "A";
    },
    description: "d",
  };
  const array = [];
  Object.defineProperty(array, "0", {
    get() {
      reads++;
      return contract()[0];
    },
    enumerable: true,
  });
  for (const criteria of [
    [getter],
    array,
    new Array(1),
    [{ ...contract()[0], verified: true }],
    [Object.assign(Object.create({ inherited: true }), contract()[0])],
  ])
    invalidInput(input(criteria));
  const hidden = { ...contract()[0] };
  Object.defineProperty(hidden, "extra", { value: true });
  invalidInput(input([hidden]));
  invalidInput({
    prompt: "x",
    output_format: "report",
    get acceptance_criteria() {
      reads++;
      return contract();
    },
  });
  for (const key of ["id", "description"]) {
    const item = { ...contract()[0] };
    Object.defineProperty(item, key, { enumerable: false });
    invalidInput(input([item]));
  }
  for (const key of ["prompt", "acceptance_criteria", "unknown"]) {
    const raw = input();
    Object.defineProperty(raw, key, {
      value: raw[key] ?? true,
      enumerable: false,
    });
    invalidInput(raw);
  }
  const hiddenIndex = [contract()[0]];
  Object.defineProperty(hiddenIndex, "0", { enumerable: false });
  invalidInput(input(hiddenIndex));
  assert.equal(reads, 0);
});

test("report exact coverage allows all self-report states and arbitrary criterion ordering", () => {
  for (const status of ["observed", "not_verified", "blocked"]) {
    const value = report();
    value.criteria[0].status = status;
    value.criteria.reverse();
    assert.deepEqual(parse(value), value);
  }
  const value = report();
  delete value.criteria;
  assert.deepEqual(parseWorkerReport(JSON.stringify(value)), value);
  assert.equal(
    Object.hasOwn(parseWorkerReport(JSON.stringify(value)), "criteria"),
    false,
  );
  assert.throws(() => parseWorkerReport(JSON.stringify(report())), {
    message: "RUNTIME_AGENT_REPORT_INVALID",
  });
});

test("report rejects missing, duplicate, unknown coverage and unsupported acceptance claims", () => {
  const value = report();
  delete value.criteria;
  invalidReport(value);
  for (const criteria of [
    [],
    null,
    [report().criteria[0]],
    [report().criteria[0], report().criteria[0]],
    [report().criteria[0], { ...report().criteria[1], id: "Other" }],
  ])
    invalidReport({ ...report(), criteria });
  for (const field of ["id", "status", "evidence_indices", "note"]) {
    const value = report();
    delete value.criteria[0][field];
    invalidReport(value);
  }
  for (const field of ["verified", "accepted", "extra"]) {
    const value = report();
    value.criteria[0][field] = true;
    invalidReport(value);
    invalidReport({ ...report(), [field]: true });
  }
  for (const status of ["verified", "accepted", "done", null, 1]) {
    const value = report();
    value.criteria[0].status = status;
    invalidReport(value);
  }
  for (const note of ["", " ", null, "n".repeat(1025)]) {
    const value = report();
    value.criteria[0].note = note;
    invalidReport(value);
  }
});

test("report indices must be safe zero-based references into evidence", () => {
  for (const evidence_indices of [
    null,
    {},
    [-1],
    [1],
    [0.5],
    [Number.MAX_SAFE_INTEGER + 1],
    ["0"],
    [null],
  ]) {
    const value = report();
    value.criteria[0].evidence_indices = evidence_indices;
    invalidReport(value);
  }
  const value = report();
  value.criteria[0].evidence_indices = [];
  assert.deepEqual(parse(value), value);
  value.outcome = "partial";
  value.evidence = [];
  value.limitations = ["Not read"];
  assert.deepEqual(parse(value), value);
  value.criteria[0].evidence_indices = [0];
  invalidReport(value);
});

test("criteria remains inside the total UTF-8 report limit", () => {
  const value = report();
  const raw = JSON.stringify(value);
  assert.deepEqual(
    parseWorkerReport(
      raw + " ".repeat(16384 - Buffer.byteLength(raw)),
      contract(),
    ),
    value,
  );
  assert.throws(
    () =>
      parseWorkerReport(
        raw + " ".repeat(16385 - Buffer.byteLength(raw)),
        contract(),
      ),
    { message: "RUNTIME_AGENT_REPORT_TOO_LARGE" },
  );
});

test("actual worker instructions preserve legacy prompts and hash the full criteria contract", () => {
  assert.equal(
    workerInstructions(parseAgentInput({ prompt: "x" })),
    WORKER_ROLE_INSTRUCTIONS,
  );
  const legacy = workerInstructions(
    parseAgentInput({ prompt: "x", output_format: "report" }),
  );
  assert.equal(
    legacy,
    WORKER_ROLE_INSTRUCTIONS + "\n\n" + WORKER_REPORT_INSTRUCTIONS,
  );
  const parsed = parseAgentInput(input());
  const actual = workerInstructions(parsed);
  assert.ok(actual.includes(JSON.stringify(contract())));
  for (const phrase of [
    "exactly once",
    "zero-based",
    "not_verified",
    "not verification or acceptance",
    "16384",
  ])
    assert.ok(actual.includes(phrase));
  assert.notEqual(promptHash(actual), promptHash(legacy));
  parsed.acceptance_criteria[0].description += " changed";
  assert.notEqual(promptHash(actual), promptHash(workerInstructions(parsed)));
  assert.equal(promptHash(parsed.prompt), promptHash("  inspect  "));
});
