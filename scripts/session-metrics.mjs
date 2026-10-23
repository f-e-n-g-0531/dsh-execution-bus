#!/usr/bin/env node
/** Local, read-only session metrics; no network/telemetry. Never emit inputs,
 * commands, business paths or result bodies. IDs are pseudonymous, not anonymous.
 * node scripts/session-metrics.mjs [--sessions <dir>] [--since <ISO>] [--preset <name>] [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const RUNTIME_TOOLS = [
  "runtime_run",
  "runtime_status",
  "runtime_result",
  "runtime_cancel",
  "runtime_resume",
];
const RUN_STATES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];
const STEP_STATES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
];
const PRESETS = ["execution-bus-test", "xiao-he-runtime"];
const RAW_PRESET = Symbol("preset filter only");
const BUS_ERRORS =
  /\b(MUTATING_REUSE_DENIED|INVALID_OBJECT|INVALID_ID|INVALID_JSON|INVALID_JSON_ARRAY|INVALID_JSON_OBJECT|INVALID_JSON_KEY|INVALID_JSON_PROPERTY|INVALID_REQUEST|INVALID_CONTROL|INVALID_ADMISSION_POLICY|INVALID_OPTIONS|INVALID_HANDLER_OPTIONS|INVALID_RESOURCES|INVALID_TEST_INPUT|INVALID_READ_INPUT|INVALID_EDIT_INPUT|INVALID_WRITE_INPUT|INVALID_GLOB_INPUT|INVALID_GREP_INPUT|INVALID_PWSH_INPUT|INVALID_STATE_QUERY|QUEUE_WAIT_TIMEOUT|HANDLER_FAILED)\b/;
// Known non-metric events are ignored, not reported as unsupported.
const KNOWN_EVENTS = new Set(
  "session turn/start turn/end step/start step/end tool/call tool/result tool/ptc-dispatch tool/ptc-dispatch-start agent-preset/selected agent/inbox/spliced approval/asked approval/decided approval/policy assistant/attempt assistant/message command/done command/run compaction/end compaction/prune compaction/start compaction/summary deliverables/presented developer/message feedback/message-delete feedback/message-put feedback/record goal/change hook/invoked hook/result image/offload llm/retry llm/retry-started model/selection permission/preset plan/mode request/context request/header sandbox/mode schedule/change session-log-deepseek/delivery-accepted session/end-seed session/title session/title-llm-request subagent/catalog subagent/descriptor subagent/model-selection-policy system/message team/member team/message/delivered team/message/queued team/task todo/write tool-workflow/agent-end tool-workflow/agent-start tool-workflow/run-end tool-workflow/run-start user/message web/deepseek-search-llm-request workspace/changes".split(
    " ",
  ),
);
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const countMap = (keys) => Object.fromEntries(keys.map((key) => [key, 0]));
const pseudonym = (v) => createHash("sha256").update(String(v)).digest("hex");
const safePreset = (v) =>
  v == null ? null : PRESETS.includes(v) ? v : "other";
const numericTime = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string"
      ? Date.parse(v) || 0
      : 0;
const safeEnum = (v, values) => (values.includes(v) ? v : "other");

export function diagnostics() {
  return {
    logs: 0,
    badLogs: 0,
    unreadableLogs: 0,
    corruptFrames: 0,
    malformedLines: 0,
    missingHeaders: 0,
    unsupportedEvents: 0,
    unsupportedResults: 0,
    duplicateEvents: 0,
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    sessions: undefined,
    since: undefined,
    preset: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") out.json = true;
    else if (["--sessions", "--since", "--preset"].includes(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw Error("missing value for " + flag);
      if (flag === "--since") {
        out.since = Date.parse(value);
        if (!Number.isFinite(out.since)) throw Error("invalid --since date");
      } else out[flag.slice(2)] = value;
    } else throw Error("unsupported argument");
  }
  return out;
}

export function requireZstd(api = zlib) {
  if (typeof api.zstdDecompressSync !== "function") {
    const error = Error(
      "ZSTD_UNAVAILABLE: this Node.js build lacks zstdDecompressSync; use a Node build with zstd support (Node 22.15+ or 23.8+).",
    );
    error.code = "ZSTD_UNAVAILABLE";
    throw error;
  }
  return api.zstdDecompressSync;
}

// Zstandard frame grammar, not decoder consumption: Node/zstd versions differ
// in whether a synchronous call reads one frame or the entire concatenated input.
export function zstdFrameEnd(buffer, start = 0) {
  let cursor = start;
  const take = (size) => {
    if (size > buffer.length - cursor) throw Error("truncated zstd frame");
    const at = cursor;
    cursor += size;
    return at;
  };
  const magic = take(4);
  if (!buffer.subarray(magic, magic + 4).equals(MAGIC))
    throw Error("invalid zstd magic");
  const descriptor = buffer[take(1)];
  if (descriptor & 0x08) throw Error("reserved zstd frame bit");
  const singleSegment = Boolean(descriptor & 0x20);
  if (!singleSegment) take(1); // Window_Descriptor
  take([0, 1, 2, 4][descriptor & 3]); // Dictionary_ID
  const contentFlag = descriptor >>> 6;
  take(contentFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentFlag]);
  let last;
  do {
    const at = take(3);
    const block = buffer.readUIntLE(at, 3);
    last = Boolean(block & 1);
    const type = (block >>> 1) & 3;
    const size = block >>> 3;
    if (type === 3 || size > 128 * 1024) throw Error("invalid zstd block");
    take(type === 1 ? 1 : size); // RLE stores exactly one byte, not Block_Size.
  } while (!last);
  if (descriptor & 4) take(4); // Content_Checksum
  return cursor;
}

export function decompress(
  buffer,
  stats = diagnostics(),
  decode = requireZstd(),
) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = buffer.indexOf(MAGIC, offset);
    if (start !== offset) {
      stats.corruptFrames++;
      parts.push(Buffer.from("\n"));
    }
    if (start === -1) break;
    let end;
    try {
      end = zstdFrameEnd(buffer, start);
      // Give even a greedy concatenation decoder exactly one complete frame.
      // Its bytesWritten metadata is neither needed nor trusted for boundaries.
      parts.push(decode(buffer.subarray(start, end)));
      offset = end;
    } catch {
      stats.corruptFrames++;
      // Never stitch JSON fragments across missing/corrupt compressed data.
      parts.push(Buffer.from("\n"));
      // If framing succeeded, skip the whole failed frame, including payload
      // magic. With damaged framing, magic resynchronization is best effort only.
      const next = end ?? buffer.indexOf(MAGIC, start + MAGIC.length);
      if (next === -1) break;
      offset = next;
    }
  }
  if (!buffer.length) stats.corruptFrames++;
  // Decode UTF-8 after joining successful frames: a code point may straddle
  // frames. Corrupt regions above insert a newline so missing bytes never join.
  return Buffer.concat(parts).toString("utf8");
}

export function parseEvents(text, stats = diagnostics()) {
  const events = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      stats.malformedLines++;
      continue;
    }
    if (!object(event) || typeof event.type !== "string") {
      stats.malformedLines++;
      continue;
    }
    if (!KNOWN_EVENTS.has(event.type)) stats.unsupportedEvents++;
    if (event.seq !== undefined) {
      const key = JSON.stringify([event.type, event.seq]);
      if (seen.has(key)) {
        stats.duplicateEvents++;
        continue;
      }
      seen.add(key);
    }
    events.push(event);
  }
  return events;
}

function parsedValue(content) {
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type !== "text" || typeof block.text !== "string") continue;
      const value = parsedValue(block.text);
      if (object(value)) return value;
    }
    return null;
  }
  return object(content) ? content : null;
}

function legacyBus(data) {
  const a = parsedValue(data.arguments) ?? {};
  const content = JSON.stringify(data.content ?? "");
  const value = parsedValue(data.content);
  const grep = (re) => re.exec(content)?.[1] ?? null;
  const handler = a.handler ?? a.payload?.handler;
  const handlers = [
    "host.read",
    "host.glob",
    "host.grep",
    "host.pwsh",
    "host.edit",
    "host.write",
    "host.glob_ref",
    "host.grep_ref",
  ];
  return {
    type: safeEnum(a.type ?? "request", [
      "request",
      "status",
      "cancel",
      "result",
    ]),
    handler: handler == null ? null : safeEnum(handler, handlers),
    requestId: a.requestId == null ? null : pseudonym(a.requestId),
    state: value?.state
      ? safeEnum(value.state, [
          ...RUN_STATES,
          "queued",
          "completed",
          "fulfilled",
          "rejected",
          "pending",
        ])
      : grep(
          /state[^A-Za-z]+(queued|running|succeeded|failed|cancelled|completed|fulfilled|rejected|pending)/,
        ),
    reused: value?.reused === true || /reused[^A-Za-z]+true/.test(content),
    error: grep(BUS_ERRORS),
  };
}

export function metricsFromEvents(events, stats = diagnostics()) {
  const header = events.find((event) => event.type === "session");
  if (!header) {
    stats.missingHeaders++;
    return null;
  }
  const calls = countMap(RUNTIME_TOOLS);
  const runs = new Map();
  const bus = [];
  const pending = new Map();
  const seenCalls = new Set();
  const settledCalls = new Set();
  const busIndexes = new Map();
  let pwsh = 0,
    jobReads = 0,
    runtimeErrors = 0,
    unsupportedRuntimeCalls = 0;
  function observe(value, time) {
    if (!object(value)) return false;
    if (Array.isArray(value.runs)) {
      return value.runs.map((run) => observe(run, time)).every(Boolean);
    }
    if (typeof value.runId !== "string" || !RUN_STATES.includes(value.state))
      return false;
    let run = runs.get(value.runId);
    if (!run) {
      run = { state: value.state, time: -Infinity, steps: new Map() };
      runs.set(value.runId, run);
    }
    const stamp = numericTime(value.updatedAt) || time;
    if (stamp >= run.time) {
      run.state = value.state;
      run.time = stamp;
    }
    if (Array.isArray(value.steps)) {
      for (const step of value.steps) {
        if (
          !object(step) ||
          typeof step.id !== "string" ||
          !STEP_STATES.includes(step.state)
        )
          continue;
        const old = run.steps.get(step.id);
        const attempts =
          Number.isSafeInteger(step.attempts) && step.attempts >= 0
            ? step.attempts
            : null;
        run.steps.set(step.id, {
          state: !old || stamp >= old.time ? step.state : old.state,
          time: Math.max(stamp, old?.time ?? -Infinity),
          attempts:
            attempts === null
              ? (old?.attempts ?? null)
              : Math.max(attempts, old?.attempts ?? 0),
        });
      }
    }
    return true;
  }
  function countCall(data) {
    const id = data.subCallId ?? data.callId;
    if (id !== undefined && seenCalls.has(id)) return;
    if (id !== undefined) seenCalls.add(id);
    if (data.name === "execution_bus") {
      if (id !== undefined) busIndexes.set(id, bus.length);
      // Count the request now, but defer result-derived state/reuse/error until
      // its settled event. Interrupted calls never acquire an invented result.
      bus.push(legacyBus({ ...data, content: undefined }));
    }
    if (data.name === "pwsh") pwsh++;
    if (data.name === "job_output") jobReads++;
    if (RUNTIME_TOOLS.includes(data.name)) calls[data.name]++;
    else if (data.name.startsWith("runtime_")) unsupportedRuntimeCalls++;
  }
  function dispatch(data, time) {
    if (!object(data) || typeof data.name !== "string") {
      stats.unsupportedEvents++;
      return;
    }
    const name = data.name;
    const id = data.subCallId ?? data.callId;
    if (id !== undefined && settledCalls.has(id)) return;
    if (id !== undefined) settledCalls.add(id);
    countCall(data);
    if (name === "execution_bus") {
      const index = id === undefined ? bus.length - 1 : busIndexes.get(id);
      if (index !== undefined) bus[index] = legacyBus(data);
    }
    if (!RUNTIME_TOOLS.includes(name)) return;
    if (data.isError) {
      runtimeErrors++;
      return;
    }
    if (!observe(parsedValue(data.content), time)) stats.unsupportedResults++;
  }
  for (const event of events) {
    const data = event.data;
    const time = numericTime(event.time);
    if (event.type === "tool/ptc-dispatch") dispatch(data, time);
    else if (
      (event.type === "tool/call" ||
        event.type === "tool/ptc-dispatch-start") &&
      object(data)
    ) {
      // Direct calls settle in tool/result; PTC calls settle in ptc-dispatch.
      if (
        typeof data.name === "string" &&
        (data.name.startsWith("runtime_") ||
          ["execution_bus", "pwsh", "job_output"].includes(data.name))
      ) {
        const id = data.subCallId ?? data.callId;
        if (event.type === "tool/call" && id !== undefined)
          pending.set(id, data);
        countCall(data);
      }
    } else if (event.type === "tool/result" && object(data)) {
      const message = data.message;
      const callId = message?.callId ?? message?.toolCallId;
      const call = pending.get(callId);
      if (call) {
        pending.delete(callId);
        dispatch(
          {
            ...call,
            content: message.content,
            isError: Boolean(data.error) || message.isError === true,
          },
          time,
        );
      }
    }
  }
  const states = countMap(RUN_STATES),
    stepStates = countMap(STEP_STATES);
  let observedSteps = 0,
    stepsWithAttempts = 0,
    observedAttempts = 0,
    observedRetryAttempts = 0;
  for (const run of runs.values()) {
    states[run.state]++;
    for (const step of run.steps.values()) {
      observedSteps++;
      stepStates[step.state]++;
      if (step.attempts !== null) {
        stepsWithAttempts++;
        observedAttempts += step.attempts;
        observedRetryAttempts += Math.max(0, step.attempts - 1);
      }
    }
  }
  const createdAt = numericTime(header.createdAt);
  const end = events.reduce(
    (max, event) => Math.max(max, numericTime(event.time)),
    createdAt,
  );
  const row = {
    id: pseudonym(header.id ?? "unknown"),
    preset: safePreset(header.agentPreset),
    origin: safeEnum(header.origin ?? "parent", [
      "parent",
      "subagent",
      "fork",
      "child",
    ]),
    createdAt: createdAt || null,
    minutes: createdAt
      ? Math.round(Math.max(0, end - createdAt) / 6000) / 10
      : 0,
    turns: events.filter((e) => e.type === "turn/start").length,
    steps: events.filter((e) => e.type === "step/start").length,
    toolCalls: events.filter((e) => e.type === "tool/call").length,
    ptcDispatches: events.filter((e) => e.type === "tool/ptc-dispatch").length,
    pwsh,
    jobReads,
    bus,
    runtime: {
      calls,
      errors: runtimeErrors,
      unsupportedCalls: unsupportedRuntimeCalls,
      observedRuns: runs.size,
      states,
      observedSteps,
      stepStates,
      stepsWithAttempts,
      observedAttempts,
      observedRetryAttempts,
    },
  };
  Object.defineProperty(row, RAW_PRESET, { value: header.agentPreset });
  return row;
}

export function metricsFor(
  file,
  stats = diagnostics(),
  decode = requireZstd(),
) {
  stats.logs++;
  const before =
    stats.corruptFrames + stats.malformedLines + stats.missingHeaders;
  let row = null;
  try {
    row = metricsFromEvents(
      parseEvents(decompress(readFileSync(file), stats, decode), stats),
      stats,
    );
  } catch {
    stats.unreadableLogs++;
  }
  if (
    stats.corruptFrames + stats.malformedLines + stats.missingHeaders >
      before ||
    !row
  )
    stats.badLogs++;
  return row;
}

export function walk(dir, out = [], stats = diagnostics()) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    stats.unreadableLogs++;
    return out;
  }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      stats.unreadableLogs++;
      continue;
    }
    if (st.isDirectory()) walk(full, out, stats);
    else if (name.endsWith(".jsonl.zstd")) out.push(full);
  }
  return out;
}

export function summarize(rows) {
  const sum = (fn) => rows.reduce((n, row) => n + fn(row), 0);
  return {
    sessions: rows.length,
    modeSessions: rows.filter((r) => r.preset === "execution-bus-test").length,
    runtimeModeSessions: rows.filter((r) => r.preset === "xiao-he-runtime")
      .length,
    sessionsWithBusCalls: rows.filter((r) => r.bus.length > 0).length,
    busCalls: sum((r) => r.bus.length),
    busRequests: sum((r) => r.bus.filter((c) => c.type === "request").length),
    reusedHits: sum((r) => r.bus.filter((c) => c.reused).length),
    busErrors: sum((r) => r.bus.filter((c) => c.error).length),
    nativePwshCalls: sum((r) => r.pwsh),
    nativeJobReads: sum((r) => r.jobReads),
    sessionsWithRuntimeCalls: rows.filter((r) =>
      Object.values(r.runtime.calls).some((n) => n > 0),
    ).length,
    runtimeCalls: sum((r) =>
      Object.values(r.runtime.calls).reduce((a, b) => a + b, 0),
    ),
    runtimeRequests: sum((r) => r.runtime.calls.runtime_run),
    runtimeCancelRequests: sum((r) => r.runtime.calls.runtime_cancel),
    runtimeResumeRequests: sum((r) => r.runtime.calls.runtime_resume),
    runtimeErrors: sum((r) => r.runtime.errors),
    unsupportedRuntimeCalls: sum((r) => r.runtime.unsupportedCalls),
    observedRuntimeRuns: sum((r) => r.runtime.observedRuns),
    runtimeStates: Object.fromEntries(
      RUN_STATES.map((state) => [state, sum((r) => r.runtime.states[state])]),
    ),
    observedRuntimeSteps: sum((r) => r.runtime.observedSteps),
    runtimeStepStates: Object.fromEntries(
      STEP_STATES.map((state) => [
        state,
        sum((r) => r.runtime.stepStates[state]),
      ]),
    ),
    runtimeStepsWithAttempts: sum((r) => r.runtime.stepsWithAttempts),
    observedRuntimeAttempts: sum((r) => r.runtime.observedAttempts),
    observedRuntimeRetryAttempts: sum((r) => r.runtime.observedRetryAttempts),
  };
}

export function main(argv = process.argv.slice(2)) {
  const opt = parseArgs(argv);
  const decode = requireZstd(); // Never silently report zero on Node without zstd.
  const stats = diagnostics();
  const root =
    opt.sessions ??
    path.join(
      process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? ".", ".dsh"),
      "sessions",
    );
  const rows = walk(root, [], stats)
    .map((file) => metricsFor(file, stats, decode))
    .filter(Boolean)
    .filter(
      (row) => opt.since === undefined || (row.createdAt ?? 0) >= opt.since,
    )
    .filter((row) => opt.preset === undefined || row[RAW_PRESET] === opt.preset)
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const report = {
    summary: summarize(rows),
    diagnostics: stats,
    sessions: rows,
    scope:
      "Local session observations only. Diagnostics cover all scanned logs before filters. Runs/steps are deduplicated per session. Retry attempts require observed step.attempts; cancel/resume are requests, not proof of cancellation/recovery. Missing results are not inferred; no exactly-once, savings, or network telemetry claims.",
  };
  if (opt.json) console.log(JSON.stringify(report, null, 2));
  else {
    const s = report.summary;
    console.log(
      "sessions:",
      s.sessions,
      "| with execution_bus calls:",
      s.sessionsWithBusCalls,
      "| xiao-he-runtime:",
      s.runtimeModeSessions,
    );
    console.log(
      "bus calls:",
      s.busCalls,
      "| requests:",
      s.busRequests,
      "| reused hits:",
      s.reusedHits,
      "| errors:",
      s.busErrors,
    );
    console.log(
      "runtime calls:",
      s.runtimeCalls,
      "| observed runs:",
      s.observedRuntimeRuns,
      "| cancel requests:",
      s.runtimeCancelRequests,
      "| resume requests:",
      s.runtimeResumeRequests,
      "| observed retry attempts:",
      s.observedRuntimeRetryAttempts,
    );
    console.log("diagnostics:", JSON.stringify(stats));
    console.log(report.scope);
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    // Filesystem messages may contain business paths.
    console.error(
      error?.code === "ZSTD_UNAVAILABLE"
        ? error.message
        : "Session metrics failed: invalid arguments or inaccessible local logs.",
    );
    process.exitCode = 1;
  }
}
