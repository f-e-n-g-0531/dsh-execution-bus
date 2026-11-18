#!/usr/bin/env node
/** Local, read-only session metrics; no network/telemetry. Never emit inputs,
 * commands, business paths or result bodies. IDs are pseudonymous, not anonymous.
 * node scripts/session-metrics.mjs [--sessions <dir>] [--since <ISO>] [--preset <creation-name>] [--project <cwd>] [--origin root|child|unknown] [--json]
 */
import { readdirSync, readFileSync, lstatSync } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const RUNTIME_TOOLS = [
  "runtime_capabilities",
  "runtime_acknowledge",
  "runtime_review",
  "runtime_decision",
  "runtime_handoff",
  "runtime_notification",
  "runtime_query",
  "runtime_task",
  "runtime_run",
  "runtime_status",
  "runtime_result",
  "runtime_cancel",
  "runtime_resume",
];
// Read-only observation APIs only; notification and review may mutate ledgers.
const OBSERVATION_TOOLS = [
  "runtime_capabilities", "runtime_status", "runtime_result", "runtime_query", "runtime_task",
];
const ORIGINS = ["root", "child", "unknown"];
// SDK SessionHeader: origin?: 'subagent'; parentSession may describe an ordinary
// historical fork. Never promote absent origin/depth to proof of a root task.
function classifyOrigin(header) {
  const depth = header.delegationDepth;
  if (header.origin === "subagent" &&
      (depth === undefined || (Number.isSafeInteger(depth) && depth > 0)))
    return { classification: "child", evidence: "header.origin=subagent" };
  if (header.origin === undefined && depth === 0)
    return { classification: "root", evidence: "header.delegationDepth=0" };
  return { classification: "unknown", evidence: "insufficient-or-conflicting-header" };
}
function requestKinds(calls) {
  return {
    executionRequests: calls.runtime_run,
    observationRequests: OBSERVATION_TOOLS.reduce((n, name) => n + calls[name], 0),
    controlRequests: RUNTIME_TOOLS.filter((name) =>
      name !== "runtime_run" && !OBSERVATION_TOOLS.includes(name)
    ).reduce((n, name) => n + calls[name], 0),
  };
}
function usagePath(kinds, nativeCalls) {
  const parts = [];
  if (kinds.executionRequests) parts.push("execution");
  if (kinds.observationRequests) parts.push("observation");
  if (kinds.controlRequests) parts.push("control");
  if (nativeCalls) parts.push("nativeDelegation");
  return parts.join("+") || "noRuntimeOrDelegationObserved";
}
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
const PRESETS = ["execution-bus-test", "xiao-he-runtime", "ptc", "native"];
const RAW_PRESET = Symbol("preset filter only");
const RAW_PROJECT = Symbol("project filter only");
const NATIVE_DELEGATION = ["subagent", "subagent_codex", "subagent_fork"];
// Compare local creation cwd exactly, not by prefix; never serialize it.
const projectKey = (v) =>
  typeof v !== "string" || !v
    ? null
    : /^[a-z]:[\\/]|^\\\\/i.test(v)
      ? path.win32.resolve(v).toLowerCase()
      : path.resolve(v);
const sampleQuality = (row) =>
  row.quality.callsSeenResultsUnseen > 0 ||
  row.quality.delegationCallsSeenResultsUnseen > 0 ||
  row.quality.delegationCallsWithoutIds > 0 ||
  row.quality.callsWithoutIds > 0 ||
  row.quality.unpairedResults > 0 ||
  row.runtime.unsupportedCalls > 0 ||
  Object.entries(row.quality.diagnostics).some(
    ([key, value]) => !["logs", "duplicateEvents"].includes(key) && value > 0,
  )
    ? "partial"
    : "withoutDetectedGaps";
const addDiagnostics = (target, source) => {
  for (const key of Object.keys(diagnostics())) target[key] += source[key] ?? 0;
};
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
    malformedPresetSelections: 0,
    snapshotMissingRuns: 0,
  };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    sessions: undefined,
    since: undefined,
    preset: undefined,
    project: undefined,
    origin: undefined,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--json") out.json = true;
    else if (
      ["--sessions", "--since", "--preset", "--project", "--origin"].includes(flag)
    ) {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw Error("missing value for " + flag);
      if (flag === "--since") {
        out.since = Date.parse(value);
        if (!Number.isFinite(out.since)) throw Error("invalid --since date");
      } else if (flag === "--origin") {
        if (!ORIGINS.includes(value)) throw Error("invalid --origin");
        out.origin = value;
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
  const initialDiagnostics = { ...stats };
  const calls = countMap(RUNTIME_TOOLS);
  const segments = [];
  function newSegment(rawPreset, source) {
    const segment = {
      index: segments.length,
      preset: safePreset(rawPreset),
      source,
      turns: 0,
      steps: 0,
      toolCallRequests: 0,
      runtimeCalls: countMap(RUNTIME_TOOLS),
      nativeDelegationCalls: countMap(NATIVE_DELEGATION),
      dagRequests: 0,
      dagAgentStepRequests: 0,
      dagToolStepRequests: 0,
      dagUnknownStepRequests: 0,
    };
    segments.push(segment);
    return segment;
  }
  let segment = newSegment(header.agentPreset, "creation");
  const runtimePending = new Set();
  const delegationPending = new Set();
  let delegationCallsWithoutIds = 0,
    delegationMissingIdStarts = 0;
  let unpairedResults = 0,
    callsWithoutIds = 0,
    missingIdStarts = 0;
  const resultCounts = countMap(RUNTIME_TOOLS);
  const runs = new Map();
  const missingSnapshotRuns = new Set();
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
      if (value.pagination?.mode === "snapshot" && Array.isArray(value.pagination.missingRunIds)) {
        for (const id of value.pagination.missingRunIds) {
          if (typeof id !== "string" || !id || missingSnapshotRuns.has(id)) continue;
          missingSnapshotRuns.add(id);
          stats.snapshotMissingRuns++;
        }
      }
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
    const owner = segment;
    owner.toolCallRequests++;
    if (NATIVE_DELEGATION.includes(data.name)) {
      owner.nativeDelegationCalls[data.name]++;
      if (id !== undefined) delegationPending.add(id);
      else {
        delegationCallsWithoutIds++;
        delegationMissingIdStarts++;
      }
    }
    if (RUNTIME_TOOLS.includes(data.name)) {
      owner.runtimeCalls[data.name]++;
      if (id !== undefined) runtimePending.add(id);
      else {
        callsWithoutIds++;
        missingIdStarts++;
      }
    }
    if (data.name === "runtime_run") {
      owner.dagRequests++;
      const args = parsedValue(data.arguments);
      const steps = args?.plan?.steps;
      if (Array.isArray(steps))
        for (const step of steps) {
          if (step?.tool === "agent") owner.dagAgentStepRequests++;
          else if (
            ["read", "glob", "grep", "edit", "write", "pwsh"].includes(
              step?.tool,
            )
          )
            owner.dagToolStepRequests++;
          else owner.dagUnknownStepRequests++;
        }
    }
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
    if (NATIVE_DELEGATION.includes(name)) {
      if (id !== undefined) delegationPending.delete(id);
      else delegationMissingIdStarts--; // Never pair separate id-less observations.
    }
    if (!RUNTIME_TOOLS.includes(name)) return;
    if (id !== undefined) runtimePending.delete(id);
    else missingIdStarts--; // Only settle this record, never pair an earlier id-less start.
    resultCounts[name]++;
    if (data.isError) {
      runtimeErrors++;
      return;
    }
    const value = parsedValue(data.content);
    // These APIs return non-run envelopes. Recognition is not success/acceptance.
    const auxiliary =
      name === "runtime_capabilities"
        ? object(value) &&
          value.ordinaryDag === "supported" &&
          ["conditional", "unavailable"].includes(value.worker)
        : name === "runtime_handoff"
          ? object(value) && value.kind === "untrusted_run_handoff"
          : name === "runtime_notification"
            ? object(value) &&
              typeof value.runId === "string" &&
              object(value.current)
            : false;
    if (!auxiliary && !observe(value, time)) stats.unsupportedResults++;
  }
  for (const event of events) {
    const data = event.data;
    const time = numericTime(event.time);
    if (event.type === "agent-preset/selected") {
      if (typeof data?.agentPreset === "string")
        segment = newSegment(data.agentPreset, "selection");
      else {
        stats.malformedPresetSelections++;
        segment = newSegment(null, "unknown-selection");
      }
    }
    if (event.type === "turn/start") segment.turns++;
    if (event.type === "step/start") segment.steps++;
    if (event.type === "tool/ptc-dispatch") dispatch(data, time);
    else if (
      (event.type === "tool/call" ||
        event.type === "tool/ptc-dispatch-start") &&
      object(data)
    ) {
      // Direct calls settle in tool/result; PTC calls settle in ptc-dispatch.
      if (typeof data.name === "string") {
        const id = data.subCallId ?? data.callId;
        if (event.type === "tool/call" && id !== undefined)
          pending.set(id, data);
        countCall(data);
      }
      if (
        event.type === "tool/call" &&
        typeof data.name === "string" &&
        data.callId !== undefined
      )
        pending.set(data.callId, data);
    } else if (event.type === "tool/result" && object(data)) {
      const message = data.message;
      const callId = message?.callId ?? message?.toolCallId;
      const call = pending.get(callId);
      if (!call && !settledCalls.has(callId)) unpairedResults++;
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
  for (const item of segments) {
    item.usageObserved = item.turns > 0 || item.steps > 0 || item.toolCallRequests > 0;
    item.requestKinds = requestKinds(item.runtimeCalls);
    item.usagePath = usagePath(item.requestKinds,
      Object.values(item.nativeDelegationCalls).reduce((a, b) => a + b, 0));
  }
  const row = {
    id: pseudonym(header.id ?? "unknown"),
    preset: safePreset(header.agentPreset),
    creationPreset: safePreset(header.agentPreset),
    finalPreset: segment.preset,
    presetSegments: segments,
    origin: header.origin === "subagent" ? "subagent" : "unknown",
    originClass: classifyOrigin(header).classification,
    originEvidence: classifyOrigin(header).evidence,
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
      requestKinds: requestKinds(calls),
      calls,
      resultsSeen: resultCounts,
      callsSeenResultsUnseen: runtimePending.size + missingIdStarts,
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
  row.quality = {
    diagnostics: Object.fromEntries(
      Object.keys(diagnostics()).map((key) => [
        key,
        stats[key] - initialDiagnostics[key],
      ]),
    ),
    callsSeenResultsUnseen: row.runtime.callsSeenResultsUnseen,
    callsWithoutIds,
    delegationCallsSeenResultsUnseen:
      delegationPending.size + delegationMissingIdStarts,
    delegationCallsWithoutIds,
    unpairedResults,
    status: "observations-only",
  };
  row.quality.classification = sampleQuality(row);
  Object.defineProperty(row, RAW_PRESET, { value: header.agentPreset });
  Object.defineProperty(row, RAW_PROJECT, { value: projectKey(header.cwd) });
  return row;
}

export function metricsFor(
  file,
  stats = diagnostics(),
  decode = requireZstd(),
) {
  stats.logs++;
  const initial = { ...stats, logs: stats.logs - 1 };
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
  if (row)
    row.quality.diagnostics = Object.fromEntries(
      Object.keys(diagnostics()).map((key) => [key, stats[key] - initial[key]]),
    );
  if (row) row.quality.classification = sampleQuality(row);
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
      // Do not leave the selected log tree or revisit it through aliases/cycles.
      st = lstatSync(full);
    } catch {
      stats.unreadableLogs++;
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(full, out, stats);
    else if (st.isFile() && name.endsWith(".jsonl.zstd")) out.push(full);
  }
  return out;
}

// Every rate carries its own unit/denominator. Session paths combine only active
// xiao-he segments in that session; child/unknown groups never enter root counts.
function adoptionFor(rows) {
  const selectedSegments = rows.flatMap((row) => row.presetSegments.filter(
    (s) => s.preset === "xiao-he-runtime"));
  const activeSegments = selectedSegments.filter((s) => s.usageObserved);
  const activeRows = rows.filter((row) => row.presetSegments.some(
    (s) => s.preset === "xiao-he-runtime" && s.usageObserved));
  function paths(items, denominatorUnit) {
    const counts = {};
    for (const item of items) {
      const calls = countMap(RUNTIME_TOOLS);
      let native = 0;
      for (const s of item) {
        for (const name of RUNTIME_TOOLS) calls[name] += s.runtimeCalls[name];
        native += Object.values(s.nativeDelegationCalls).reduce((a, b) => a + b, 0);
      }
      const key = usagePath(requestKinds(calls), native);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return { denominator: items.length, denominatorUnit, counts,
      fractions: Object.fromEntries(Object.entries(counts).map(([key, numerator]) =>
        [key, { numerator, denominator: items.length,
          rate: items.length ? numerator / items.length : null }])) };
  }
  const sumKind = (key) => activeSegments.reduce((n, s) => n + s.requestKinds[key], 0);
  return {
    selectedSessions: rows.length,
    createdWithXiaoHeSessions: rows.filter((r) => r.creationPreset === "xiao-he-runtime").length,
    sessionsWithXiaoHeSegments: rows.filter((r) => r.presetSegments.some(
      (s) => s.preset === "xiao-he-runtime")).length,
    actualXiaoHeSessions: activeRows.length,
    xiaoHeSegments: selectedSegments.length,
    actualXiaoHeSegments: activeSegments.length,
    xiaoHeSegmentsWithoutObservedActivity: selectedSegments.length - activeSegments.length,
    executionRequests: sumKind("executionRequests"),
    observationRequests: sumKind("observationRequests"),
    controlRequests: sumKind("controlRequests"),
    nativeDelegationRequests: activeSegments.reduce((n, s) => n +
      Object.values(s.nativeDelegationCalls).reduce((a, b) => a + b, 0), 0),
    sessionPaths: paths(activeRows.map((r) => r.presetSegments.filter(
      (s) => s.preset === "xiao-he-runtime" && s.usageObserved)), "actual-xiao-he-sessions"),
    segmentPaths: paths(activeSegments.map((s) => [s]), "actual-xiao-he-segments"),
  };
}
export function summarize(rows) {
  const sum = (fn) => rows.reduce((n, row) => n + fn(row), 0);
  return {
    sessions: rows.length,
    originSessions: Object.fromEntries(ORIGINS.map((origin) =>
      [origin, rows.filter((r) => r.originClass === origin).length])),
    xiaoHeAdoption: {
      basis: "Observed turn/start, step/start or tool request in xiao-he-runtime segments; not task suitability or success. Paths are mutually exclusive combinations; no calls does not imply inapplicability. No cross-session root-task inference.",
      byOrigin: Object.fromEntries(ORIGINS.map((origin) =>
        [origin, adoptionFor(rows.filter((r) => r.originClass === origin))])),
    },
    runtimeRequestKinds: requestKinds(Object.fromEntries(RUNTIME_TOOLS.map((name) =>
      [name, sum((r) => r.runtime.calls[name])]))),
    sampleQuality: {
      observed: rows.length,
      partial: rows.filter((r) => sampleQuality(r) === "partial").length,
      withoutDetectedGaps: rows.filter(
        (r) => sampleQuality(r) === "withoutDetectedGaps",
      ).length,
    },
    callsSeenResultsUnseen: sum((r) => r.runtime.callsSeenResultsUnseen),
    nativeDelegationCalls: Object.fromEntries(
      NATIVE_DELEGATION.map((name) => [
        name,
        sum((r) =>
          r.presetSegments.reduce(
            (n, segment) => n + segment.nativeDelegationCalls[name],
            0,
          ),
        ),
      ]),
    ),
    dagRequests: sum((r) => r.runtime.calls.runtime_run),
    dagAgentStepRequests: sum((r) =>
      r.presetSegments.reduce(
        (n, segment) => n + segment.dagAgentStepRequests,
        0,
      ),
    ),
    dagToolStepRequests: sum((r) =>
      r.presetSegments.reduce(
        (n, segment) => n + segment.dagToolStepRequests,
        0,
      ),
    ),
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
      process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"),
      "sessions",
    );
  const unknown = diagnostics();
  const selected = diagnostics(),
    excluded = diagnostics();
  const files = walk(root, [], stats);
  addDiagnostics(unknown, stats);
  const rows = [];
  for (const file of files) {
    const local = diagnostics();
    const row = metricsFor(file, local, decode);
    addDiagnostics(stats, local);
    if (!row) {
      addDiagnostics(unknown, local);
      continue;
    }
    // A readable log may still lack the metadata needed to decide a filter.
    if (
      (opt.project !== undefined && row[RAW_PROJECT] === null) ||
      (opt.since !== undefined && row.createdAt === null) ||
      (opt.preset !== undefined && row[RAW_PRESET] == null)
    ) {
      addDiagnostics(unknown, local);
      continue;
    }
    const included =
      (opt.since === undefined || (row.createdAt ?? 0) >= opt.since) &&
      (opt.preset === undefined || row[RAW_PRESET] === opt.preset) &&
      (opt.origin === undefined || row.originClass === opt.origin) &&
      (opt.project === undefined ||
        row[RAW_PROJECT] === projectKey(opt.project));
    addDiagnostics(included ? selected : excluded, local);
    if (included) rows.push(row);
  }
  rows.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const report = {
    summary: summarize(rows),
    diagnostics: stats,
    sampleDiagnostics: { selected, excluded, unknown },
    sampleCounts: {
      selected: rows.length,
      excluded: excluded.logs,
      unknown: unknown.logs,
    },
    sessions: rows,
    scope:
      "Local session observations only. diagnostics covers all scanned logs; sampleDiagnostics separates selected/excluded/unknown attribution. Origin filter uses explicit SDK header evidence; absent origin/depth is unknown, not root. Xiao-he adoption denominators use observed activity within its preset segments, separately by origin; empty selected segments are not actual use. No-call paths do not establish task suitability. runtime_run requests, read-only observation requests and ledger/control requests are separate, not successful executions. Preset filter uses creation preset; segments attribute requests to the preset when called. Project filter compares creation cwd exactly, never emitting it. Runs/steps are deduplicated per session. Retry attempts require observed step.attempts; cancel/resume are requests, not proof of cancellation/recovery. Missing results are not inferred; no exactly-once, savings, or network telemetry claims.",
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
    console.log(
      "sample diagnostics:",
      JSON.stringify(report.sampleDiagnostics),
    );
    console.log(
      "calls seen/results unseen:",
      s.callsSeenResultsUnseen,
      "| native delegation:",
      JSON.stringify(s.nativeDelegationCalls),
      "| DAG requests:",
      s.dagRequests,
    );
    console.log(
      "sample quality:",
      JSON.stringify(s.sampleQuality),
      "| filter sample counts:",
      JSON.stringify(report.sampleCounts),
    );
    console.log("origins:", JSON.stringify(s.originSessions));
    console.log("runtime request kinds:", JSON.stringify(s.runtimeRequestKinds));
    console.log("xiao-he adoption by origin:", JSON.stringify(s.xiaoHeAdoption));
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
