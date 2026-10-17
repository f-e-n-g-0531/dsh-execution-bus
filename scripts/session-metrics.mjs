#!/usr/bin/env node
/** 本地 DSH 会话日志的采用率指标：解压 zstd 多帧、统计总线调用与执行结果。
 *  仅用于维护者观察，不发网络请求、不修改任何会话。
 *  用法：node scripts/session-metrics.mjs [--sessions <dir>] [--since <ISO>] [--preset <name>] [--json]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import path from "node:path";
import process from "node:process";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function args() {
  const out = { sessions: undefined, since: undefined, preset: undefined, json: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--sessions") out.sessions = argv[++i];
    else if (argv[i] === "--since") out.since = Date.parse(argv[++i]);
    else if (argv[i] === "--preset") out.preset = argv[++i];
    else throw new Error("unknown argument: " + argv[i]);
  }
  return out;
}
function decompress(file) {
  const buf = readFileSync(file);
  const parts = [];
  let i = 0;
  while (true) {
    const idx = buf.indexOf(MAGIC, i);
    if (idx === -1) break;
    i = idx + 4;
    try {
      const text = zstdDecompressSync(buf.subarray(idx)).toString("utf8");
      if (text.startsWith("{")) parts.push(text);
    } catch {}
  }
  return parts.join("");
}
const grep = (text, re) => re.exec(text)?.[1] ?? null;
function metricsFor(file) {
  const events = [];
  for (const line of decompress(file).split("\n")) {
    if (line) {
      try { events.push(JSON.parse(line)); } catch {}
    }
  }
  const header = events.find((e) => e.type === "session");
  if (!header) return null;
  const end = Math.max(...events.map((e) => e.time ?? 0));
  const bus = [];
  let pwsh = 0, jobReads = 0;
  for (const e of events) {
    if (e.type !== "tool/ptc-dispatch") continue;
    const name = e.data?.name;
    if (name === "execution_bus") {
      const a = e.data?.arguments ?? {};
      const content = JSON.stringify(e.data?.content ?? "");
      bus.push({
        type: a.type ?? "request",
        handler: a.handler ?? a.payload?.handler ?? null,
        requestId: a.requestId ?? null,
        state: grep(content, /state[^A-Za-z]+([a-z]+)/),
        reused: content.includes("reused") && content.includes("true"),
        error: grep(content, /(MUTATING_REUSE_DENIED|INVALID_[A-Z_]+|QUEUE_WAIT_TIMEOUT|HANDLER_FAILED)/),
      });
    }
    if (name === "pwsh") pwsh++;
    if (name === "job_output") jobReads++;
  }
  return {
    id: header.id ?? path.basename(path.dirname(file)),
    cwd: header.cwd ?? "",
    preset: header.agentPreset ?? null,
    origin: header.origin ?? "parent",
    createdAt: header.createdAt ?? null,
    minutes: header.createdAt ? Math.round(((end - header.createdAt) / 60000) * 10) / 10 : 0,
    turns: events.filter((e) => e.type === "turn/start").length,
    steps: events.filter((e) => e.type === "step/start").length,
    toolCalls: events.filter((e) => e.type === "tool/call").length,
    ptcDispatches: events.filter((e) => e.type === "tool/ptc-dispatch").length,
    pwsh,
    jobReads,
    bus,
  };
}
function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = path.join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith(".jsonl.zstd")) out.push(full);
  }
  return out;
}
const opt = args();
const root = opt.sessions ?? path.join(process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? ".", ".dsh"), "sessions");
const rows = walk(root, [])
  .map((file) => { try { return metricsFor(file); } catch { return null; } })
  .filter(Boolean)
  .filter((r) => (opt.since === undefined || (r.createdAt ?? 0) >= opt.since))
  .filter((r) => opt.preset === undefined || r.preset === opt.preset)
  .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
const summary = {
  sessions: rows.length,
  modeSessions: rows.filter((r) => r.preset === "execution-bus-test").length,
  sessionsWithBusCalls: rows.filter((r) => r.bus.length > 0).length,
  busCalls: rows.reduce((n, r) => n + r.bus.length, 0),
  busRequests: rows.reduce((n, r) => n + r.bus.filter((c) => c.type === "request").length, 0),
  reusedHits: rows.reduce((n, r) => n + r.bus.filter((c) => c.reused).length, 0),
  busErrors: rows.reduce((n, r) => n + r.bus.filter((c) => c.error).length, 0),
  nativePwshCalls: rows.reduce((n, r) => n + r.pwsh, 0),
  nativeJobReads: rows.reduce((n, r) => n + r.jobReads, 0),
};
if (opt.json) console.log(JSON.stringify({ summary, sessions: rows }, null, 2));
else {
  console.log("sessions:", summary.sessions, "| with execution_bus calls:", summary.sessionsWithBusCalls);
  console.log("bus calls:", summary.busCalls, "| requests:", summary.busRequests, "| reused hits:", summary.reusedHits, "| errors:", summary.busErrors);
  for (const r of rows) {
    if (r.bus.length === 0 && r.preset !== "execution-bus-test") continue;
    console.log([r.id.slice(0, 8), r.preset ?? "-", r.origin, r.turns + "t", r.steps + "s", "bus=" + r.bus.length, "pwsh=" + r.pwsh, r.bus.map((c) => c.type + ":" + (c.handler ?? "-") + (c.reused ? "(reused)" : "")).join(",")].join(" | "));
  }
}
