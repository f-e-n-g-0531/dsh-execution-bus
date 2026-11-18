import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import {
  RUNTIME_TOOLS,
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
  zstdFrameEnd,
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

compressedTest(
  "default sessions root uses OS home, not cwd when DSH_HOME is absent",
  (t) => {
    const home = fixture(t);
    const sessions = path.join(home, ".dsh", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      path.join(sessions, "one.jsonl.zstd"),
      zlib.zstdCompressSync(encode([header()])),
    );
    const previous = {
      DSH_HOME: process.env.DSH_HOME,
      USERPROFILE: process.env.USERPROFILE,
    };
    delete process.env.DSH_HOME;
    process.env.USERPROFILE = path.join(home, "unrelated-profile");
    t.mock.method(os, "homedir", () => home);
    try {
      const result = capture(["--json"]);
      assert.equal(result.report.summary.sessions, 1);
      assert.equal(result.report.diagnostics.unreadableLogs, 0);
      assert.equal(result.output.includes(home), false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);

test("walk skips directory aliases, cycles and out-of-root links", (t) => {
  const root = fixture(t);
  const sessions = path.join(root, "sessions");
  const nested = path.join(sessions, "nested");
  const outside = path.join(root, "outside");
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  const log = path.join(nested, "one.jsonl.zstd");
  writeFileSync(log, "fixture");
  writeFileSync(path.join(outside, "private.jsonl.zstd"), "must not traverse");
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(nested, path.join(sessions, "alias"), type);
  symlinkSync(outside, path.join(sessions, "external"), type);
  const stats = diagnostics();
  assert.deepEqual(walk(sessions, [], stats), [log]);
  symlinkSync(sessions, path.join(nested, "loop"), type);
  assert.deepEqual(walk(sessions, [], stats), [log]);
  assert.equal(stats.unreadableLogs, 0);
});

test("module import has no CLI side effects; zstd capability is checked at runtime", () => {
  assert.throws(() => requireZstd({}), { code: "ZSTD_UNAVAILABLE" });
  const decode = () => {};
  assert.equal(requireZstd({ zstdDecompressSync: decode }), decode);
  assert.equal(summarize([]).sessions, 0);
});
// A valid raw-block frame, including arbitrary magic bytes in its payload.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function rawFrame(payload) {
  const block = Buffer.alloc(3);
  block.writeUIntLE((payload.length << 3) | 1, 0, 3);
  return Buffer.concat([
    MAGIC,
    Buffer.from([0x20, payload.length]),
    block,
    payload,
  ]);
}
const rawDecode = (frame) => frame.subarray(9);

test("frame cursor consumes embedded magic once and reports empty/corrupt input", () => {
  const input = rawFrame(MAGIC);
  const stats = diagnostics();
  let calls = 0;
  assert.equal(
    decompress(input, stats, (buffer) => {
      calls++;
      assert.deepEqual(buffer, input);
      return Buffer.from("one-frame");
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
  decompress(MAGIC, stats, () => {
    throw Error("bad frame");
  });
  assert.equal(stats.corruptFrames, 2);
});

test("greedy multi-frame decoder receives only complete individual frames around corruption", () => {
  const first = rawFrame(Buffer.from(encode([header()])));
  const last = rawFrame(
    Buffer.from(encode([dispatch("runtime_status", { runs: [] })])),
  );
  const invalid = Buffer.concat([MAGIC, Buffer.from([0xff, 0xff])]);
  // Models a newer decoder that eagerly reads all frames in the supplied slice
  // and throws if ANY trailing frame is malformed (losing earlier output).
  const greedy = (input) => {
    const parts = [];
    for (let offset = 0; offset < input.length; ) {
      const end = zstdFrameEnd(input, offset);
      parts.push(rawDecode(input.subarray(offset, end)));
      offset = end;
    }
    return Buffer.concat(parts);
  };
  assert.throws(() => greedy(Buffer.concat([first, invalid, last])));
  const stats = diagnostics();
  const text = decompress(Buffer.concat([first, invalid, last]), stats, greedy);
  const row = metricsFromEvents(parseEvents(text, stats), stats);
  assert.ok(row);
  assert.equal(row.runtime.calls.runtime_status, 1);
  assert.equal(stats.corruptFrames, 1);
  assert.equal(stats.missingHeaders, 0);
});

test("decode failure skips known frame payload magic; UTF-8 may span successful frames", () => {
  const chinese = Buffer.from("萧何\n");
  const first = rawFrame(chinese.subarray(0, 2));
  const last = rawFrame(chinese.subarray(2));
  const stats = diagnostics();
  assert.equal(
    decompress(Buffer.concat([first, last]), stats, rawDecode),
    "萧何\n",
  );
  assert.equal(stats.corruptFrames, 0);
  const bad = rawFrame(Buffer.concat([Buffer.from("bad"), MAGIC]));
  let calls = 0;
  assert.equal(
    decompress(Buffer.concat([first, bad, last]), stats, (frame) => {
      calls++;
      if (frame.equals(bad)) throw Error("checksum failure");
      return rawDecode(frame);
    }).includes("萧何"),
    false,
  );
  assert.equal(calls, 3);
  assert.equal(stats.corruptFrames, 1);
});

test("frame grammar handles descriptor fields, RLE, multiblock, checksum and truncation", () => {
  // Non-single-segment, dictionary=4, content-size=8, checksum=4.
  const frame = Buffer.concat([
    MAGIC,
    Buffer.from([0xc7, 0]),
    Buffer.alloc(4 + 8),
    Buffer.from([0x32, 0, 0, 0x41]), // non-last RLE, expanded size=6, one stored byte
    Buffer.from([0x09, 0, 0, 0x42]), // last raw block, one stored byte
    Buffer.alloc(4),
  ]);
  assert.equal(zstdFrameEnd(frame), frame.length);
  for (let size = 0; size < frame.length; size++) {
    assert.throws(() => zstdFrameEnd(frame.subarray(0, size)));
  }
  const reserved = rawFrame(Buffer.from("x"));
  reserved[6] |= 6; // reserved block type
  assert.throws(() => zstdFrameEnd(reserved));
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

test("snapshot gaps are redacted, deduplicated and separate from observed runs", () => {
  const snapshot = (runs, missingRunIds) => ({
    runs,
    pagination: {
      mode: "snapshot",
      capturedAt: 1000,
      expiresAt: 301000,
      total: 3,
      missingRunIds,
      nextCursor: "private-snapshot-cursor",
    },
  });
  const observed = run("succeeded", [step("a", "succeeded", 2)]);
  const page = dispatch(
    "runtime_status",
    snapshot([observed], ["private-missing-a", "private-missing-a"]),
    { subCallId: "snapshot-page" },
  );
  const stats = diagnostics();
  const row = metricsFromEvents([
    header(),
    page,
    page,
    dispatch("runtime_status", snapshot([], ["private-duplicate-only"]), {
      subCallId: "snapshot-page",
    }),
    directCall("runtime_task", "snapshot-task"),
    {
      type: "tool/result",
      data: {
        message: {
          toolCallId: "snapshot-task",
          content: blocks(snapshot([], ["private-missing-a", "private-missing-b"])),
        },
      },
    },
    dispatch("runtime_result", observed, { subCallId: "observed-again" }),
  ], stats);

  assert.equal(stats.snapshotMissingRuns, 2);
  assert.equal(stats.unsupportedResults, 0);
  assert.equal(row.quality.diagnostics.snapshotMissingRuns, 2);
  assert.equal(row.quality.classification, "partial");
  assert.equal(row.runtime.callsSeenResultsUnseen, 0);
  assert.equal(row.runtime.resultsSeen.runtime_status, 1);
  assert.equal(row.runtime.resultsSeen.runtime_task, 1);
  assert.equal(row.runtime.observedRuns, 1);
  assert.equal(row.runtime.observedSteps, 1);
  assert.equal(row.runtime.observedAttempts, 2);
  assert.equal(summarize([row]).sampleQuality.partial, 1);
  assert.doesNotMatch(JSON.stringify(row), /private-missing|private-duplicate|private-snapshot-cursor/);
});

test("empty snapshot gaps and non-snapshot pagination do not make a sample partial", () => {
  const row = metricsFromEvents([
    header(),
    dispatch("runtime_status", {
      runs: [],
      pagination: { mode: "snapshot", missingRunIds: [] },
    }, { subCallId: "snapshot-empty" }),
    dispatch("runtime_status", {
      runs: [],
      pagination: { mode: "offset", missingRunIds: ["private-ignored"] },
    }, { subCallId: "offset-page" }),
  ]);
  assert.equal(row.quality.diagnostics.snapshotMissingRuns, 0);
  assert.equal(row.quality.classification, "withoutDetectedGaps");
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

// Shapes checked in installed dsh-session/types, dsh-tool-executor-ptc/types,
// and dsh-agent-preset-registry/session declarations.
const directCall = (name, callId, args = {}) => ({
  type: "tool/call",
  data: { turn: 1, step: 1, name, callId, arguments: JSON.stringify(args) },
});
const directResult = (toolCallId, value, isError = false) => ({
  type: "tool/result",
  data: {
    turn: 1,
    step: 1,
    message: { role: "tool", toolCallId, content: blocks(value), isError },
  },
});
const selection = (agentPreset) => ({
  type: "agent-preset/selected",
  data: { agentPreset },
});

test("allowlist matches all current registered runtime interfaces", () => {
  const plugin = readFileSync(
    new URL("../src/plugin.ts", import.meta.url),
    "utf8",
  );
  const names = [...plugin.matchAll(/register\(\s*"(runtime_[a-z_]+)"/g)].map(
    (m) => m[1],
  );
  assert.equal(names.length, 13);
  assert.deepEqual([...RUNTIME_TOOLS].sort(), names.sort());
});

test("runtime envelopes recognized without manufacturing run success", () => {
  const stats = diagnostics();
  const response = (name) =>
    name === "runtime_capabilities"
      ? { ordinaryDag: "supported", worker: "unavailable" }
      : name === "runtime_handoff"
        ? { kind: "untrusted_run_handoff", summary: "PRIVATE" }
        : name === "runtime_notification"
          ? { runId: "PRIVATE", current: { shouldNotify: true } }
          : ["runtime_query", "runtime_task", "runtime_status"].includes(name)
            ? { runs: [] }
            : run("running", []);
  const row = metricsFromEvents(
    [
      header(),
      ...RUNTIME_TOOLS.flatMap((name, i) => [
        directCall(name, String(i)),
        directResult(String(i), response(name)),
      ]),
    ],
    stats,
  );
  for (const name of RUNTIME_TOOLS) {
    assert.equal(row.runtime.calls[name], 1);
    assert.equal(row.runtime.resultsSeen[name], 1);
  }
  assert.equal(stats.unsupportedResults, 0);
  assert.equal(row.runtime.callsSeenResultsUnseen, 0);
  assert.equal(row.runtime.states.succeeded, 0);
  assert.equal(JSON.stringify(row).includes("PRIVATE"), false);
});

test("segments attribute starts not late results; native delegation separate from DAG", () => {
  const row = metricsFromEvents([
    header("execution-bus-test"),
    directCall("runtime_run", "dag", {
      plan: {
        steps: [{ tool: "agent" }, { tool: "read" }, { tool: "future" }],
      },
    }),
    selection("xiao-he-runtime"),
    { type: "turn/start" },
    { type: "step/start" },
    directResult("dag", run("succeeded", [])),
    directCall("subagent", "native"),
    directResult("native", { name: "PRIVATE" }),
    {
      type: "tool/ptc-dispatch-start",
      data: {
        rootCallId: "root",
        parentCallId: "root",
        subCallId: "fork",
        name: "subagent_fork",
        arguments: {},
      },
    },
    dispatch("subagent_fork", {}, { subCallId: "fork" }),
    dispatch("subagent_codex", {}),
    selection("PRIVATE-PRESET"),
    dispatch("runtime_capabilities", {
      ordinaryDag: "supported",
      worker: "unavailable",
    }),
  ]);
  assert.equal(row.preset, "execution-bus-test");
  assert.equal(row.creationPreset, row.preset);
  assert.equal(row.finalPreset, "other");
  assert.equal(row.presetSegments.length, 3);
  const [a, b, c] = row.presetSegments;
  assert.equal(a.runtimeCalls.runtime_run, 1);
  assert.equal(b.runtimeCalls.runtime_run, 0);
  assert.equal(a.dagAgentStepRequests, 1);
  assert.equal(a.dagToolStepRequests, 1);
  assert.equal(a.dagUnknownStepRequests, 1);
  assert.equal(b.turns, 1);
  assert.equal(b.steps, 1);
  assert.deepEqual(b.nativeDelegationCalls, {
    subagent: 1,
    subagent_codex: 1,
    subagent_fork: 1,
  });
  assert.equal(c.runtimeCalls.runtime_capabilities, 1);
  assert.equal(summarize([row]).dagRequests, 1);
  assert.equal(JSON.stringify(row).includes("PRIVATE"), false);
});

test("malformed preset selection marks unknown attribution", () => {
  const stats = diagnostics();
  const row = metricsFromEvents(
    [
      header(),
      { type: "agent-preset/selected", data: { preset: "WRONG" } },
      directCall("runtime_cancel", "pending"),
    ],
    stats,
  );
  assert.equal(stats.malformedPresetSelections, 1);
  assert.equal(row.finalPreset, null);
  assert.equal(row.presetSegments[1].source, "unknown-selection");
  assert.equal(row.presetSegments[1].runtimeCalls.runtime_cancel, 1);
});

test("missing results explicit; errors and unrecognized results are not missing", () => {
  const row = metricsFromEvents([
    header(),
    directCall("runtime_cancel", "missing"),
    directCall("runtime_cancel", "missing"),
    {
      type: "tool/ptc-dispatch-start",
      data: { subCallId: "missing-ptc", name: "runtime_run", arguments: {} },
    },
    directCall("runtime_resume", "error"),
    directResult("error", {}, true),
    directCall("runtime_status", "bad"),
    directResult("bad", "not json"),
    directCall("read", "ordinary"),
    directResult("ordinary", { text: "PRIVATE" }),
    directResult("orphan", {}),
    { type: "tool/call", data: { name: "runtime_task", arguments: "{}" } },
  ]);
  assert.equal(row.runtime.callsSeenResultsUnseen, 3);
  assert.equal(row.quality.callsSeenResultsUnseen, 3);
  assert.equal(row.quality.callsWithoutIds, 1);
  assert.equal(row.quality.unpairedResults, 1);
  assert.equal(row.runtime.errors, 1);
  assert.equal(row.quality.diagnostics.unsupportedResults, 1);
  assert.equal(row.runtime.states.cancelled, 0);
  assert.equal(row.runtime.states.succeeded, 0);
});

compressedTest(
  "diagnostics partition selected excluded unknown without leaking filters",
  (t) => {
    const dir = fixture(t);
    const writeLog = (name, text) =>
      writeFileSync(
        path.join(dir, name + ".jsonl.zstd"),
        zlib.zstdCompressSync(text),
      );
    writeLog(
      "selected",
      encode([
        { ...header(), cwd: "G:/PRIVATE/project" },
        directCall("runtime_run", "pending"),
      ]) + "bad\n",
    );
    writeLog(
      "excluded",
      encode([{ ...header(), cwd: "G:/PRIVATE/project-other" }]) + "bad\nbad\n",
    );
    writeLog("missing-cwd", encode([{ ...header(), cwd: undefined }]));
    writeLog("missing-header", encode([dispatch("runtime_cancel", {})]));
    const result = capture([
      "--sessions",
      dir,
      "--project",
      "g:/private/PROJECT/",
      "--json",
    ]);
    assert.equal(result.report.summary.sessions, 1);
    assert.equal(result.report.sampleDiagnostics.selected.logs, 1);
    assert.equal(result.report.sampleDiagnostics.selected.malformedLines, 1);
    assert.equal(result.report.sampleDiagnostics.excluded.logs, 1);
    assert.equal(result.report.sampleDiagnostics.excluded.malformedLines, 2);
    assert.equal(result.report.sampleDiagnostics.unknown.logs, 2);
    assert.equal(result.report.sampleDiagnostics.unknown.missingHeaders, 1);
    assert.equal(
      result.report.sessions[0].quality.diagnostics.malformedLines,
      1,
    );
    for (const key of Object.keys(diagnostics()))
      assert.equal(
        result.report.diagnostics[key],
        ["selected", "excluded", "unknown"].reduce(
          (n, part) => n + result.report.sampleDiagnostics[part][key],
          0,
        ),
      );
    assert.equal(result.output.includes("PRIVATE"), false);
    assert.equal(result.output.includes(dir), false);
  },
);

test("project argument requires a value", () => {
  assert.throws(() => parseArgs(["--project"]));
  assert.throws(() => parseArgs(["--project", "--json"]));
  assert.equal(parseArgs(["--project", "local"]).project, "local");
});

test("public ptc/native labels remain distinguishable while custom labels stay private", () => {
  const row = metricsFromEvents([
    header("ptc"),
    selection("native"),
    selection("PRIVATE-custom"),
  ]);
  assert.equal(row.creationPreset, "ptc");
  assert.deepEqual(
    row.presetSegments.map((s) => s.preset),
    ["ptc", "native", "other"],
  );
  assert.equal(JSON.stringify(row).includes("PRIVATE-custom"), false);
});

compressedTest(
  "creation preset and date filters do not use switched preset or excluded diagnostics",
  (t) => {
    const dir = fixture(t);
    for (const [name, events] of [
      [
        "old",
        [{ ...header("ptc"), createdAt: 1000 }, selection("xiao-he-runtime")],
      ],
      [
        "new",
        [{ ...header("xiao-he-runtime"), createdAt: 3000 }, selection("ptc")],
      ],
    ])
      writeFileSync(
        path.join(dir, name + ".jsonl.zstd"),
        zlib.zstdCompressSync(encode(events) + "bad\n"),
      );
    const r = capture([
      "--sessions",
      dir,
      "--preset",
      "xiao-he-runtime",
      "--since",
      "1970-01-01T00:00:02Z",
      "--json",
    ]).report;
    assert.equal(r.summary.sessions, 1);
    assert.equal(r.sessions[0].finalPreset, "ptc");
    assert.equal(r.sampleDiagnostics.selected.malformedLines, 1);
    assert.equal(r.sampleDiagnostics.excluded.malformedLines, 1);
  },
);

test("id-less result records never settle earlier unidentifiable starts", () => {
  const row = metricsFromEvents([
    header(),
    { type: "tool/call", data: { name: "runtime_status", arguments: "{}" } },
    dispatch("runtime_status", { runs: [] }),
  ]);
  assert.equal(row.runtime.calls.runtime_status, 2);
  assert.equal(row.runtime.resultsSeen.runtime_status, 1);
  assert.equal(row.runtime.callsSeenResultsUnseen, 1);
  assert.equal(row.quality.callsWithoutIds, 2);
});

compressedTest(
  "quality denominators distinguish gaps without claiming completeness",
  (t) => {
    const dir = fixture(t);
    const samples = [
      encode([header("ptc", "a")]),
      encode([header("ptc", "b"), directCall("runtime_run", "pending")]),
      encode([header("ptc", "c"), { type: "future/event" }]),
      encode([header("ptc", "d")]) + "broken\n",
      encode([{ type: "turn/start" }]),
    ];
    samples.forEach((text, i) =>
      writeFileSync(
        path.join(dir, i + ".jsonl.zstd"),
        zlib.zstdCompressSync(text),
      ),
    );
    const report = capture(["--sessions", dir, "--json"]).report;
    assert.deepEqual(report.summary.sampleQuality, {
      observed: 4,
      partial: 3,
      withoutDetectedGaps: 1,
    });
    assert.deepEqual(report.sampleCounts, {
      selected: 4,
      excluded: 0,
      unknown: 1,
    });
    assert.equal(
      report.sessions.filter((r) => r.quality.classification === "partial")
        .length,
      3,
    );
    assert.ok(
      report.sessions.every((r) => r.quality.status === "observations-only"),
    );
  },
);

test("origin uses SDK evidence, not absent origin or parent/fork guesses", () => {
  const cases = [
    [{}, "unknown"],
    [{ parentSession: "PRIVATE" }, "unknown"],
    [{ origin: "parent" }, "unknown"],
    [{ origin: "root" }, "unknown"],
    [{ origin: "child" }, "unknown"],
    [{ delegationDepth: 0 }, "root"],
    [{ delegationDepth: 1 }, "unknown"],
    [{ origin: "subagent" }, "child"],
    [{ origin: "subagent", delegationDepth: 1 }, "child"],
    [{ origin: "subagent", delegationDepth: 0 }, "unknown"],
    [{ origin: "subagent", delegationDepth: -1 }, "unknown"],
    [{ origin: "subagent", delegationDepth: "1" }, "unknown"],
  ];
  for (const [meta, expected] of cases) {
    const row = metricsFromEvents([{ ...header(), ...meta }]);
    assert.equal(row.originClass, expected);
    assert.notEqual(row.origin, "parent");
    assert.equal(JSON.stringify(row).includes("PRIVATE"), false);
  }
});

test("adoption denominators separate creation, actual segments and root/child/unknown", () => {
  const make = (meta, events, preset = "xiao-he-runtime") =>
    metricsFromEvents([{ ...header(preset), ...meta }, ...events]);
  const rows = [
    make({ delegationDepth: 0 }, [selection("native"), directCall("runtime_run", "outside")]),
    make({ delegationDepth: 0 }, [selection("xiao-he-runtime"),
      directCall("runtime_capabilities", "observe"), directCall("subagent", "child"),
      selection("native"), directCall("runtime_run", "outside")], "native"),
    make({ delegationDepth: 0 }, [{ type: "turn/start" }]),
    make({ delegationDepth: 0 }, [directCall("runtime_run", "execute"),
      directCall("runtime_status", "status"), directCall("runtime_cancel", "control")]),
    make({ origin: "subagent", delegationDepth: 1 }, [directCall("runtime_run", "execute-child")]),
    make({}, [directCall("runtime_query", "query-unknown")]),
    make({ delegationDepth: 0 }, [directCall("read", "ordinary")]),
    make({ delegationDepth: 0 }, [directCall("subagent_fork", "native-only")]),
  ];
  const summary = summarize(rows);
  assert.deepEqual(summary.originSessions, { root: 6, child: 1, unknown: 1 });
  const root = summary.xiaoHeAdoption.byOrigin.root;
  assert.equal(root.selectedSessions, 6);
  assert.equal(root.createdWithXiaoHeSessions, 5);
  assert.equal(root.sessionsWithXiaoHeSegments, 6);
  assert.equal(root.actualXiaoHeSessions, 5);
  assert.equal(root.xiaoHeSegments, 6);
  assert.equal(root.actualXiaoHeSegments, 5);
  assert.equal(root.xiaoHeSegmentsWithoutObservedActivity, 1);
  assert.equal(root.executionRequests, 1); // outside xiao-he never counts
  assert.equal(root.observationRequests, 2);
  assert.equal(root.controlRequests, 1);
  assert.equal(root.nativeDelegationRequests, 2);
  assert.equal(root.sessionPaths.denominator, 5);
  assert.deepEqual(root.sessionPaths.counts, {
    "observation+nativeDelegation": 1,
    noRuntimeOrDelegationObserved: 2,
    "execution+observation+control": 1,
    nativeDelegation: 1,
  });
  assert.deepEqual(root.sessionPaths.fractions.noRuntimeOrDelegationObserved,
    { numerator: 2, denominator: 5, rate: 0.4 });
  assert.equal(summary.xiaoHeAdoption.byOrigin.child.executionRequests, 1);
  assert.equal(summary.xiaoHeAdoption.byOrigin.unknown.observationRequests, 1);
  const empty = summarize([]).xiaoHeAdoption.byOrigin.root;
  assert.equal(empty.sessionPaths.denominator, 0);
  assert.deepEqual(empty.sessionPaths.fractions, {});
  assert.deepEqual(summary.runtimeRequestKinds,
    { executionRequests: 4, observationRequests: 3, controlRequests: 1 });
  // Compatibility fields remain whole-session and creation-based.
  assert.equal(summary.runtimeModeSessions, 7);
  assert.equal(summary.runtimeRequests, 4);
  assert.equal(JSON.stringify(summary).includes("inapplicability"), true);
});

test("repeated active xiao-he segments have separate segment and session denominators", () => {
  const row = metricsFromEvents([header(), directCall("runtime_run", "one"),
    selection("native"), selection("xiao-he-runtime"), directCall("subagent", "two")]);
  const group = summarize([row]).xiaoHeAdoption.byOrigin.unknown;
  assert.equal(group.sessionPaths.denominator, 1);
  assert.equal(group.segmentPaths.denominator, 2);
  assert.deepEqual(group.sessionPaths.counts, { "execution+nativeDelegation": 1 });
  assert.deepEqual(group.segmentPaths.counts, { execution: 1, nativeDelegation: 1 });
});

test("runtime execution and observation categories never treat ledger mutations as queries", () => {
  const row = metricsFromEvents([header(), ...RUNTIME_TOOLS.map((name) => directCall(name, name))]);
  assert.deepEqual(row.runtime.requestKinds,
    { executionRequests: 1, observationRequests: 5, controlRequests: 7 });
  assert.deepEqual(row.presetSegments[0].requestKinds, row.runtime.requestKinds);
});

compressedTest("origin filter selects explicit classes without private metadata output", (t) => {
  const dir = fixture(t);
  const metas = [{ delegationDepth: 0 }, { origin: "subagent" }, { parentSession: "PRIVATE" }];
  for (const [i, meta] of metas.entries()) writeFileSync(path.join(dir, i + ".jsonl.zstd"),
    zlib.zstdCompressSync(encode([{ ...header(), ...meta }])));
  for (const origin of ["root", "child", "unknown"]) {
    const result = capture(["--sessions", dir, "--origin", origin, "--json"]);
    assert.equal(result.report.summary.sessions, 1);
    assert.equal(result.report.sessions[0].originClass, origin);
    assert.equal(result.report.sampleCounts.excluded, 2);
    assert.equal(result.output.includes("PRIVATE"), false);
    assert.equal(result.output.includes(dir), false);
  }
});

test("origin argument accepts only documented evidence classes", () => {
  for (const origin of ["root", "child", "unknown"])
    assert.equal(parseArgs(["--origin", origin]).origin, origin);
  for (const args of [["--origin"], ["--origin", "--json"], ["--origin", "parent"],
    ["--origin", "subagent"]]) assert.throws(() => parseArgs(args));
});

for (const name of ["subagent", "subagent_codex", "subagent_fork"]) {
  test(name + " result gaps independently downgrade sample quality", () => {
    const missing = metricsFromEvents([header(), directCall(name, "pending")]);
    assert.equal(missing.quality.classification, "partial");
    assert.equal(missing.quality.delegationCallsSeenResultsUnseen, 1);
    assert.equal(missing.runtime.callsSeenResultsUnseen, 0);
    const missingPtc = metricsFromEvents([
      header(),
      {
        type: "tool/ptc-dispatch-start",
        data: { name, subCallId: "ptc", arguments: {} },
      },
    ]);
    assert.equal(missingPtc.quality.classification, "partial");
    assert.equal(missingPtc.quality.delegationCallsSeenResultsUnseen, 1);
    const noId = metricsFromEvents([
      header(),
      { type: "tool/call", data: { name, arguments: "{}" } },
      dispatch(name, {}),
    ]);
    assert.equal(noId.quality.classification, "partial");
    assert.equal(noId.quality.delegationCallsWithoutIds, 2);
    assert.equal(noId.quality.delegationCallsSeenResultsUnseen, 1);
    const settledOnly = metricsFromEvents([header(), dispatch(name, {})]);
    assert.equal(settledOnly.quality.classification, "partial");
    assert.equal(settledOnly.quality.delegationCallsWithoutIds, 1);
    assert.equal(settledOnly.quality.delegationCallsSeenResultsUnseen, 0);
    const settled = metricsFromEvents([
      header(),
      directCall(name, "ok"),
      directResult("ok", { name: "PRIVATE" }),
    ]);
    assert.equal(settled.quality.classification, "withoutDetectedGaps");
    assert.equal(settled.quality.delegationCallsSeenResultsUnseen, 0);
    assert.equal(settled.quality.delegationCallsWithoutIds, 0);
    const ptc = metricsFromEvents([
      header(),
      {
        type: "tool/ptc-dispatch-start",
        data: { name, subCallId: "ptc", arguments: {} },
      },
      dispatch(name, {}, { subCallId: "ptc" }),
    ]);
    assert.equal(ptc.quality.classification, "withoutDetectedGaps");
    assert.equal(ptc.quality.delegationCallsSeenResultsUnseen, 0);
    assert.equal(JSON.stringify(settled).includes("PRIVATE"), false);
  });
}
