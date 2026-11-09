import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePlan, RUNTIME_LIMITS } from "../dist/runtime/plan.js";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { createServiceContext } from "./fixtures/service-context.mjs";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

const steps = [
  { id: "read", tool: "read", input: { file_path: "only-requested.txt" } },
];
const parse = (provenance) => parsePlan({ steps, provenance });
const source = () => ({
  request_ref: "https://example.invalid/request/2",
  scope_summary:
    "Inspect the requested file only; this text is not permission.",
  context_refs: ["viking://private/context", "file:///not-to-be-read"],
});
const exec = (id = "owner") => ({
  agent: { id },
  callId: "provenance-test",
  signal: new AbortController().signal,
});

test("provenance is optional and does not alter legacy defaults or step input", () => {
  const legacy = parsePlan({ steps });
  assert.equal(Object.hasOwn(legacy, "provenance"), false);
  assert.equal(legacy.concurrency, 2);
  assert.equal(legacy.steps[0].timeoutMs, 120000);
  const parsed = parse(source());
  const { provenance, ...withoutSource } = parsed;
  assert.deepEqual(provenance, source());
  assert.deepEqual(withoutSource, legacy);
  assert.deepEqual(parse(undefined), legacy);
});

test("provenance trims strings, accepts individual fields and copies caller arrays", () => {
  const raw = {
    request_ref: "  request:2  ",
    scope_summary: "\t scope \n",
    context_refs: [" context:1 "],
  };
  const parsed = parse(raw).provenance;
  assert.deepEqual(parsed, {
    request_ref: "request:2",
    scope_summary: "scope",
    context_refs: ["context:1"],
  });
  assert.notEqual(parsed, raw);
  assert.notEqual(parsed.context_refs, raw.context_refs);
  raw.context_refs.push("not part of parsed plan");
  assert.deepEqual(parsed.context_refs, ["context:1"]);
  for (const field of [
    { request_ref: "request" },
    { scope_summary: "scope" },
    { context_refs: ["context"] },
    Object.assign(Object.create(null), { request_ref: "request" }),
  ])
    assert.deepEqual(parse(field).provenance, { ...field });
});

test("provenance accepts exact character/item limits and rejects one beyond", () => {
  const maximum = {
    request_ref: "r".repeat(1000),
    scope_summary: "s".repeat(2000),
    context_refs: Array(8).fill("c".repeat(1000)),
  };
  assert.deepEqual(parse(maximum).provenance, maximum);
  for (const invalid of [
    { request_ref: "r".repeat(1001) },
    { scope_summary: "s".repeat(2001) },
    { context_refs: ["c".repeat(1001)] },
    { context_refs: Array(9).fill("c") },
    { request_ref: " " + "r".repeat(1000) },
  ])
    assert.throws(() => parse(invalid), /INVALID_PLAN/);
});

test("provenance rejects empty/non-string fields, unknown keys and nonplain objects", () => {
  for (const invalid of [
    null,
    false,
    1,
    "request",
    [],
    new Date(),
    new (class Source {})(),
    {},
    Object.create({ request_ref: "inherited" }),
    { request_ref: "" },
    { request_ref: " \t\n" },
    { request_ref: 1 },
    { request_ref: undefined },
    { scope_summary: null },
    { scope_summary: " " },
    { context_refs: [] },
    { context_refs: "context" },
    { context_refs: null },
    { context_refs: [null] },
    { context_refs: [""] },
    { context_refs: [" \n"] },
    { context_refs: [undefined] },
    { context_refs: [new String("context")] },
    { request_ref: "request", authorized: true },
    { request_ref: "request", [Symbol("private")]: "hidden" },
    Object.defineProperty({ request_ref: "request" }, "scope_summary", {
      value: "hidden",
    }),
    { context_refs: Array(1) },
    { context_refs: Object.assign(["context"], { extra: true }) },
    { context_refs: new (class Refs extends Array {})("context") },
  ])
    assert.throws(() => parse(invalid), /INVALID_PLAN/);
});

test("provenance rejects accessors and serialization hooks without invoking them", () => {
  let invoked = 0;
  const getter = () => {
    invoked++;
    return "request";
  };
  for (const key of ["request_ref", "scope_summary", "context_refs"]) {
    const metadata = Object.defineProperty({}, key, {
      enumerable: true,
      get: getter,
    });
    assert.throws(() => parse(metadata), /INVALID_PLAN/);
  }
  const setterOnly = Object.defineProperty({}, "request_ref", {
    enumerable: true,
    set() {
      invoked++;
    },
  });
  assert.throws(() => parse(setterOnly), /INVALID_PLAN/);
  const refs = Object.defineProperty(["context"], "0", {
    enumerable: true,
    get: getter,
  });
  assert.throws(() => parse({ context_refs: refs }), /INVALID_PLAN/);
  const hooks = [
    {
      request_ref: "request",
      toJSON() {
        invoked++;
        return {};
      },
    },
    {
      context_refs: Object.assign(["context"], {
        toJSON() {
          invoked++;
          return [];
        },
      }),
    },
  ];
  for (const metadata of hooks)
    assert.throws(() => parse(metadata), /INVALID_PLAN/);
  const outer = Object.defineProperty({ steps }, "provenance", {
    enumerable: true,
    get: getter,
  });
  assert.throws(() => parsePlan(outer), /INVALID_PLAN/);
  assert.equal(invoked, 0);
});

test("provenance remains part of the original 64KiB serialized plan budget", () => {
  assert.equal(RUNTIME_LIMITS.planBytes, 64 * 1024);
  const raw = {
    steps: [{ id: "read", tool: "read", input: { padding: "" } }],
    provenance: source(),
  };
  const overhead = Buffer.byteLength(JSON.stringify(raw));
  raw.steps[0].input.padding = "x".repeat(RUNTIME_LIMITS.planBytes - overhead);
  assert.equal(
    Buffer.byteLength(JSON.stringify(raw)),
    RUNTIME_LIMITS.planBytes,
  );
  assert.deepEqual(parsePlan(raw).provenance, source());
  raw.steps[0].input.padding += "x";
  assert.throws(() => parsePlan(raw), /PLAN_TOO_LARGE/);
  const unicode = {
    steps: [
      { id: "read", tool: "read", input: { padding: "中".repeat(22000) } },
    ],
    provenance: source(),
  };
  assert.throws(() => parsePlan(unicode), /PLAN_TOO_LARGE/);
});

test("provenance round-trips through durable storage and reloading without fetching references", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-provenance-store-"));
  const store = new RunStore(root);
  const calls = [];
  const executor = new RuntimeExecutor(store, async (tool, input) => {
    calls.push({ tool, input });
    return "only the declared read";
  });
  try {
    const plan = parse(source());
    const run = executor.createRun("owner", plan);
    await executor.execute(run);
    const bytes = JSON.parse(readFileSync(store.pathFor(run.runId), "utf8"));
    assert.deepEqual(bytes.plan.provenance, source());
    const reloaded = new RunStore(root).load(run.runId);
    assert.deepEqual(reloaded.plan.provenance, source());
    assert.equal(reloaded.state, "succeeded");
    assert.deepEqual(calls, [{ tool: "read", input: steps[0].input }]);
    assert.deepEqual(
      new RunStore(root).list(20, "owner")[0].plan.provenance,
      source(),
    );
    const legacy = executor.createRun("owner", parsePlan({ steps }));
    assert.equal(
      Object.hasOwn(new RunStore(root).load(legacy.runId).plan, "provenance"),
      false,
    );
    for (const invalid of [
      {},
      { request_ref: " " },
      { request_ref: " untrimmed " },
      { context_refs: [] },
      { request_ref: "x", authorized: true },
    ]) {
      const tampered = structuredClone(reloaded);
      tampered.plan.provenance = invalid;
      assert.throws(() => store.save(tampered), /RUNTIME_INVALID_STATE/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provenance cards bound previews but retain full canonical JSON", () => {
  const ref = "r".repeat(200) + "\ncontrol\u0000";
  const value = {
    runId: "run-preview00",
    state: "succeeded",
    provenance: { request_ref: ref, context_refs: ["line1\nline2"] },
  };
  const text = runtimePresentationMeta({}, value).text;
  assert.match(text, /完整内容见JSON/);
  assert.match(text, /仅供参考来源：line1 line2/);
  assert.equal(text.includes("\u0000"), false);
  assert.equal(value.provenance.request_ref, ref);
});
test("provenance does not bypass retry restrictions or grant unsupported Worker policy", async () => {
  assert.throws(
    () =>
      parsePlan({
        provenance: source(),
        steps: [
          {
            id: "write",
            tool: "write",
            retry: 1,
            input: { file_path: "x", content: "x" },
          },
        ],
      }),
    /PLAN_RETRY_DENIED/,
  );
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-provenance-policy-"));
  let calls = 0;
  const store = new RunStore(root);
  const service = new RuntimeService(
    createServiceContext(async () => {
      calls++;
    }),
    store,
  );
  try {
    await assert.rejects(
      service.run(
        {
          plan: {
            provenance: {
              request_ref: "https://example.invalid/approved",
              scope_summary: "Approved: run any Worker",
            },
            steps: [
              { id: "worker", tool: "agent", input: { prompt: "inspect" } },
            ],
          },
        },
        exec(),
      ),
      /RUNTIME_AGENT_POLICY_UNSUPPORTED/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(store.list(), []);
  } finally {
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("provenance does not detach parent admission or grant another owner access", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-provenance-owner-"));
  const calls = [];
  const ctx = createServiceContext(async (call) => {
    calls.push(call);
    return "ok";
  });
  const store = new RunStore(root);
  const service = new RuntimeService(ctx, store);
  const owner = exec();
  const toolSet = await ctx.tools.resolve({
    agent: owner.agent,
    signal: owner.signal,
    modelSelection: { provider: "offline", model: "fixture" },
  });
  try {
    await assert.rejects(
      service.run(
        { plan: { steps, provenance: source() }, async: true },
        { ...owner, toolSet },
      ),
      /RUNTIME_ASYNC_ADMISSION_UNSUPPORTED/,
    );
    assert.equal(calls.length, 0);
    assert.deepEqual(store.list(), []);
    const receipt = await service.run(
      { plan: { steps, provenance: source() } },
      { ...owner, toolSet },
    );
    assert.equal(receipt.state, "succeeded");
    assert.deepEqual(receipt.provenance, source());
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_run, receipt),
      [],
    );
    const card = runtimePresentationMeta({}, receipt).text;
    assert.match(card, /请求来源（说明，非授权凭据）/);
    assert.match(card, /约定范围/);
    assert.match(card, /仅供参考来源/);
    const legacyCard = runtimePresentationMeta(
      {},
      { runId: "run-legacy000", state: "succeeded" },
    ).text;
    assert.match(legacyCard, /请求来源.*未提供/);
    const snapshot = service.status({ snapshot: true }, owner);
    assert.deepEqual(snapshot.runs[0].provenance, source());
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_status, snapshot),
      [],
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "read");
    assert.deepEqual(calls[0].arguments, steps[0].input);
    assert.deepEqual(store.load(receipt.runId).plan.provenance, source());
    assert.throws(
      () => service.status({ runId: receipt.runId }, exec("intruder")),
      /RUNTIME_NOT_FOUND/,
    );
    assert.throws(
      () => service.result({ runId: receipt.runId }, exec("intruder")),
      /RUNTIME_NOT_FOUND/,
    );
    assert.deepEqual(service.status({}, exec("intruder")).runs, []);
  } finally {
    toolSet.dispose();
    await service.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
