import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import {
  decompress,
  diagnostics,
  main,
  metricsFor,
  metricsFromEvents,
  parseArgs,
  parseEvents,
  requireZstd,
  summarize,
  walk,
} from "../scripts/session-metrics.mjs";

const header = (preset = "xiao-he-runtime", id = "private-session") => ({
  type: "session",
  id,
  cwd: "G:/private-business",
  agentPreset: preset,
  createdAt: 1000,
});
const blocks = (value) => [{ type: "text", text: JSON.stringify(value) }];
const dispatch = (name, value, extra = {}) => ({
  type: "tool/ptc-dispatch",
  time: 2000,
  data: { name, arguments: {}, content: blocks(value), ...extra },
});
const step = (id, state, attempts) => ({ id, state, attempts, tool: "read" });
const run = (state, steps, updatedAt = 2000) => ({
  runId: "run-private",
  state,
  steps,
  updatedAt,
});
const encode = (events) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const hasZstd =
  typeof zlib.zstdCompressSync === "function" &&
  typeof zlib.zstdDecompressSync === "function";
const compressedTest = (name, fn) =>
  test(name, { skip: !hasZstd && "Node build has no zstd API" }, fn);
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function capture(args) {
  const lines = [];
  const original = console.log;
  console.log = (...values) => lines.push(values.join(" "));
  try {
    return { report: main(args), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("module import has no CLI side effects; zstd capability is checked at runtime", () => {
  assert.throws(() => requireZstd({}), { code: "ZSTD_UNAVAILABLE" });
  const decode = () => {};
  assert.equal(requireZstd({ zstdDecompressSync: decode }), decode);
  assert.equal(summarize([]).sessions, 0);
});

test("frame cursor consumes embedded magic once and reports empty/corrupt input", () => {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const input = Buffer.concat([magic, magic]);
  const stats = diagnostics();
  let calls = 0;
  assert.equal(
    decompress(input, stats, (buffer) => {
      calls++;
      return {
        buffer: Buffer.from("one-frame"),
        engine: { bytesWritten: buffer.length },
      };
    }),
    "one-frame",
  );
  assert.equal(calls, 1);
  assert.equal(stats.corruptFrames, 0);
  assert.equal(
    decompress(Buffer.alloc(0), stats, () => {}),
    "",
  );
  assert.equal(stats.corruptFrames, 1);
  decompress(magic, stats, () => {
    throw Error("bad frame");
  });
  assert.equal(stats.corruptFrames, 2);
});

test("CLI validates option values and dates without accepting accidental unfiltered scans", () => {
  const args = parseArgs([
    "--sessions",
    "local",
    "--preset",
    "xiao-he-runtime",
    "--since",
    "2026-01-01T00:00:00Z",
    "--json",
  ]);
  assert.equal(args.json, true);
  assert.equal(args.since, Date.parse("2026-01-01T00:00:00Z"));
  for (const flags of [
    ["--sessions"],
    ["--preset", "--json"],
    ["--since", "bad"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseArgs(flags));
  }
});

test("legacy execution_bus summary and native dispatch counters remain available", () => {
  const row = metricsFromEvents([
    header("execution-bus-test"),
    dispatch(
      "execution_bus",
      { state: "succeeded", reused: true },
      { arguments: { handler: "host.read", requestId: "private-request" } },
    ),
    dispatch(
      "execution_bus",
      { error: "MUTATING_REUSE_DENIED" },
      { arguments: { type: "status", payload: { handler: "host.glob" } } },
    ),
    dispatch("pwsh", { stdout: "private" }),
    dispatch("job_output", "private"),
    { type: "turn/start" },
    { type: "step/start" },
    { type: "tool/call", data: { name: "run_code" } },
  ]);
  const s = summarize([row]);
  assert.equal(s.modeSessions, 1);
  assert.equal(s.busCalls, 2);
  assert.equal(s.busRequests, 1);
  assert.equal(s.reusedHits, 1);
  assert.equal(s.busErrors, 1);
  assert.equal(s.nativePwshCalls, 1);
  assert.equal(s.nativeJobReads, 1);
  assert.equal(row.bus[0].handler, "host.read");
  assert.equal(row.bus[0].state, "succeeded");
  assert.match(row.bus[0].requestId, /^[a-f0-9]{64}$/);
  assert.equal(row.turns, 1);
});

test("runtime observations deduplicate runId and step attempts across status/list/result", () => {
  const row = metricsFromEvents([
    header(),
    dispatch("runtime_run", run("running", [step("a", "running", 1)])),
    dispatch(
      "runtime_status",
      run("succeeded", [step("a", "succeeded", 3)], 4000),
    ),
    dispatch("runtime_status", {
      runs: [
        {
          runId: "run-private",
          state: "succeeded",
          updatedAt: 4000,
          stepCount: 1,
        },
      ],
    }),
    dispatch("runtime_result", {
      ...run("succeeded", [step("a", "succeeded", 3)], 4000),
      results: { a: { value: "private" } },
    }),
    dispatch("runtime_status", run("running", [step("a", "running", 1)], 2000)),
  ]);
  const s = summarize([row]);
  assert.equal(s.runtimeModeSessions, 1);
  assert.equal(s.runtimeCalls, 5);
  assert.equal(s.observedRuntimeRuns, 1);
  assert.equal(s.runtimeStates.succeeded, 1);
  assert.equal(s.runtimeStates.running, 0);
  assert.equal(s.observedRuntimeSteps, 1);
  assert.equal(s.runtimeStepStates.succeeded, 1);
  assert.equal(s.observedRuntimeAttempts, 3);
  assert.equal(s.observedRuntimeRetryAttempts, 2);
});

test("retry config, cancel and resume requests do not imply execution or recovery success", () => {
  const stats = diagnostics();
  const row = metricsFromEvents(
    [
      header(),
      dispatch(
        "runtime_run",
        { runId: "run-private", state: "running" },
        { arguments: { plan: { steps: [{ retry: 3 }] } } },
      ),
      dispatch("runtime_cancel", { runId: "run-private", state: "running" }),
      dispatch("runtime_resume", {}, { isError: true }),
      dispatch(
        "runtime_status",
        run("interrupted", [step("a", "unknown", undefined)]),
      ),
    ],
    stats,
  );
  const s = summarize([row]);
  assert.equal(s.runtimeCancelRequests, 1);
  assert.equal(s.runtimeResumeRequests, 1);
  assert.equal(s.runtimeStates.cancelled, 0);
  assert.equal(s.runtimeStates.interrupted, 1);
  assert.equal(s.runtimeStepsWithAttempts, 0);
  assert.equal(s.observedRuntimeRetryAttempts, 0);
  assert.equal(s.runtimeErrors, 1);
  assert.equal(stats.unsupportedResults, 0);
});

test("direct tool/result and PTC start/settle count each request once", () => {
  const row = metricsFromEvents([
    header(),
    {
      type: "tool/call",
      data: { name: "runtime_run", callId: "direct", arguments: "{}" },
    },
    {
      type: "tool/result",
      time: 3000,
      data: {
        message: {
          toolCallId: "direct",
          content: blocks(run("succeeded", [step("a", "succeeded", 2)])),
        },
      },
    },
    {
      type: "tool/ptc-dispatch-start",
      data: { name: "runtime_status", subCallId: "status" },
    },
    dispatch("runtime_status", run("succeeded", [step("a", "succeeded", 2)]), {
      subCallId: "status",
    }),
    dispatch("runtime_status", run("succeeded", [step("a", "succeeded", 2)]), {
      subCallId: "status",
    }),
    {
      type: "tool/ptc-dispatch-start",
      data: { name: "runtime_cancel", subCallId: "interrupted-request" },
    },
  ]);
  assert.equal(summarize([row]).runtimeCalls, 3);
  assert.equal(row.runtime.observedRuns, 1);
  assert.equal(row.runtime.observedAttempts, 2);
});

test("direct native/bus calls and results count once, including interrupted requests", () => {
  const direct = (name, callId, args = {}) => ({
    type: "tool/call",
    data: { name, callId, arguments: JSON.stringify(args) },
  });
  const result = (callId, value) => ({
    type: "tool/result",
    data: { message: { toolCallId: callId, content: blocks(value) } },
  });
  const pwsh = direct("pwsh", "native", { command: "private-command" });
  const job = direct("job_output", "job", { job_id: "private-job" });
  const bus = direct("execution_bus", "bus", {
    handler: "host.read",
    requestId: "private-id",
  });
  const row = metricsFromEvents([
    header("execution-bus-test"),
    pwsh,
    pwsh,
    result("native", { stdout: "private-output" }),
    result("native", { stdout: "private-output" }),
    dispatch("pwsh", { stdout: "private-output" }, { subCallId: "native" }),
    job,
    result("job", { text: "private-result" }),
    bus,
    result("bus", { state: "succeeded", reused: true }),
    result("bus", { error: "HANDLER_FAILED" }),
    dispatch("execution_bus", { state: "failed" }, { subCallId: "bus" }),
    direct("execution_bus", "bus-interrupted", { type: "status" }),
    direct("pwsh", "native-interrupted"),
    direct("job_output", "job-interrupted"),
  ]);
  const s = summarize([row]);
  assert.equal(s.nativePwshCalls, 2);
  assert.equal(s.nativeJobReads, 2);
  assert.equal(s.busCalls, 2);
  assert.equal(s.busRequests, 1);
  assert.equal(s.reusedHits, 1);
  assert.equal(s.busErrors, 0);
  assert.equal(row.bus[0].handler, "host.read");
  assert.equal(row.bus[0].state, "succeeded");
  assert.equal(row.bus[1].state, null);
  assert.equal(row.bus[1].reused, false);
  assert.equal(JSON.stringify(row).includes("private"), false);
});

test("PTC native/bus start defers result fields and settled event updates instead of appending", () => {
  const start = (name, subCallId, args = {}) => ({
    type: "tool/ptc-dispatch-start",
    data: { name, subCallId, arguments: args },
  });
  const before = metricsFromEvents([
    header(),
    start("execution_bus", "bus", { handler: "host.glob" }),
  ]);
  assert.equal(before.bus.length, 1);
  assert.equal(before.bus[0].state, null);
  const row = metricsFromEvents([
    header(),
    start("execution_bus", "bus", { handler: "host.glob" }),
    dispatch(
      "execution_bus",
      { state: "failed", error: "HANDLER_FAILED" },
      { subCallId: "bus", arguments: { handler: "host.glob" } },
    ),
    dispatch(
      "execution_bus",
      { state: "failed", error: "HANDLER_FAILED" },
      { subCallId: "bus" },
    ),
    start("pwsh", "native"),
    dispatch("pwsh", {}, { subCallId: "native" }),
    start("job_output", "job"),
    dispatch("job_output", {}, { subCallId: "job" }),
  ]);
  const s = summarize([row]);
  assert.equal(s.busCalls, 1);
  assert.equal(s.busErrors, 1);
  assert.equal(row.bus[0].state, "failed");
  assert.equal(row.bus[0].handler, "host.glob");
  assert.equal(s.nativePwshCalls, 1);
  assert.equal(s.nativeJobReads, 1);
});

test("bad lines, missing headers, unsupported events/results and duplicate seq are counted", () => {
  const stats = diagnostics();
  const events = parseEvents(
    encode([
      header(),
      { type: "turn/start", seq: 1 },
      { type: "turn/start", seq: 1 },
      { type: "future/event", data: "private-event" },
      null,
      [],
      {},
      dispatch("runtime_future", {}),
      dispatch("runtime_status", "not-json"),
      dispatch("runtime_status", { runId: "x", state: "future" }),
    ]) + "broken-json\n",
    stats,
  );
  const row = metricsFromEvents(events, stats);
  assert.equal(row.turns, 1);
  assert.equal(stats.duplicateEvents, 1);
  assert.equal(stats.unsupportedEvents, 1);
  assert.equal(stats.malformedLines, 4);
  assert.equal(stats.unsupportedResults, 2);
  assert.equal(row.runtime.unsupportedCalls, 1);
  assert.equal(row.runtime.observedRuns, 0);
  assert.equal(metricsFromEvents([], stats), null);
  assert.equal(stats.missingHeaders, 1);
});

test("output allowlist excludes business fields and arbitrary labels", () => {
  const secret = "PRIVATE-BUSINESS";
  const row = metricsFromEvents([
    { ...header(secret, secret), cwd: secret, origin: secret },
    dispatch(
      "runtime_result",
      {
        ...run("failed", [
          {
            id: secret,
            state: "failed",
            attempts: 1,
            tool: secret,
            error: secret,
          },
        ]),
        goal: secret,
        error: secret,
        results: { [secret]: secret },
      },
      { arguments: { input: secret, command: secret, file_path: secret } },
    ),
    dispatch(
      "execution_bus",
      { state: secret, reused: false, error: "INVALID_PRIVATE_BUSINESS" },
      { arguments: { handler: secret, type: secret, requestId: secret } },
    ),
  ]);
  const output = JSON.stringify({ summary: summarize([row]), sessions: [row] });
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes("INVALID_PRIVATE_BUSINESS"), false);
  assert.equal("cwd" in row, false);
});

compressedTest(
  "real concatenated zstd frames preserve split JSON lines without double counting",
  (t) => {
    const dir = fixture(t);
    const text = encode([
      header(),
      dispatch("runtime_run", run("succeeded", [step("a", "succeeded", 2)])),
    ]);
    const cut = 30;
    const buffer = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(text.slice(0, cut))),
      zlib.zstdCompressSync(Buffer.from(text.slice(cut))),
    ]);
    const file = path.join(dir, "events.jsonl.zstd");
    writeFileSync(file, buffer);
    const stats = diagnostics();
    assert.equal(decompress(buffer, stats), text);
    assert.equal(stats.corruptFrames, 0);
    const row = metricsFor(file, stats);
    assert.equal(row.runtime.calls.runtime_run, 1);
    assert.equal(stats.logs, 1);
    assert.equal(stats.badLogs, 0);
  },
);

compressedTest(
  "damaged frames, malformed JSON and unreadable logs are visible, valid frames survive",
  (t) => {
    const dir = fixture(t);
    const file = path.join(dir, "bad.jsonl.zstd");
    writeFileSync(
      file,
      Buffer.concat([
        zlib.zstdCompressSync(Buffer.from(encode([header()]))),
        Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0xff, 0xff]),
        zlib.zstdCompressSync(
          Buffer.from(
            "invalid\n" + encode([dispatch("runtime_status", { runs: [] })]),
          ),
        ),
      ]),
    );
    const stats = diagnostics();
    assert.ok(metricsFor(file, stats));
    assert.equal(stats.badLogs, 1);
    assert.equal(stats.corruptFrames, 1);
    assert.equal(stats.malformedLines, 1);
    assert.equal(metricsFor(path.join(dir, "missing"), stats), null);
    assert.equal(stats.unreadableLogs, 1);
    assert.equal(stats.badLogs, 2);
    assert.equal(walk(path.join(dir, "missing"), [], stats).length, 0);
    assert.equal(stats.unreadableLogs, 2);
  },
);

compressedTest(
  "CLI JSON/text are local and redacted; filters stay exact for custom presets",
  (t) => {
    const dir = fixture(t);
    const nested = path.join(dir, "private-folder");
    mkdirSync(nested);
    const files = [
      [
        "a",
        [
          header("xiao-he-runtime"),
          dispatch("runtime_run", run("succeeded", [])),
        ],
      ],
      ["b", [{ ...header("custom-private-a"), createdAt: 3000 }]],
      ["c", [{ ...header("custom-private-b"), createdAt: 4000 }]],
    ];
    for (const [name, events] of files)
      writeFileSync(
        path.join(nested, name + ".jsonl.zstd"),
        zlib.zstdCompressSync(Buffer.from(encode(events))),
      );
    writeFileSync(
      path.join(nested, "bad.jsonl.zstd"),
      Buffer.from("private-corruption"),
    );
    const before = readFileSync(path.join(nested, "a.jsonl.zstd"));
    const json = capture(["--sessions", dir, "--json"]);
    assert.equal(JSON.parse(json.output).summary.sessions, 3);
    assert.equal(json.report.diagnostics.badLogs, 1);
    assert.equal(json.report.diagnostics.missingHeaders, 1);
    assert.equal(json.output.includes("private"), false);
    assert.equal(json.output.includes(dir), false);
    const text = capture(["--sessions", dir]);
    assert.match(text.output, /observed runs:/);
    assert.equal(text.output.includes("private"), false);
    const filtered = capture([
      "--sessions",
      dir,
      "--preset",
      "custom-private-a",
      "--since",
      "1970-01-01T00:00:02Z",
      "--json",
    ]);
    assert.equal(filtered.report.summary.sessions, 1);
    assert.equal(filtered.report.sessions[0].createdAt, 3000);
    assert.equal(filtered.output.includes("custom-private-a"), false);
    assert.deepEqual(readFileSync(path.join(nested, "a.jsonl.zstd")), before);
  },
);
