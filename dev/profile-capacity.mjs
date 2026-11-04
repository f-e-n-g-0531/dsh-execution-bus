#!/usr/bin/env node
/** Development-only instrumentation: use a disposable dedicated Node process. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { historyRecord } from "../scripts/benchmark-runtime.mjs";
import { measureFsCalls } from "./fs-probe.mjs";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { RuntimeService } from "../dist/runtime/service.js";

export function parseProfileArgs(argv) {
  const out = { size: 100, ratio: 0.5 };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i],
      value = argv[i + 1];
    if (
      !["--size", "--ratio"].includes(flag) ||
      seen.has(flag) ||
      typeof value !== "string" ||
      !value.trim()
    )
      throw Error("INVALID_PROFILE_OPTIONS");
    seen.add(flag);
    out[flag === "--size" ? "size" : "ratio"] = Number(value);
  }
  return validateProfileOptions(out);
}
function validateProfileOptions(raw) {
  if (
    !raw ||
    Object.keys(raw).some((k) => !["size", "ratio"].includes(k)) ||
    !Number.isSafeInteger(raw.size) ||
    raw.size < 1 ||
    raw.size > 1000 ||
    !Number.isFinite(raw.ratio) ||
    raw.ratio < 0 ||
    raw.ratio > 1
  )
    throw Error("INVALID_PROFILE_OPTIONS");
  return { size: raw.size, ratio: raw.ratio };
}
function digest() {
  const h = createHash("sha256");
  for (const file of [
    "dev/profile-capacity.mjs",
    "dev/fs-probe.mjs",
    "scripts/benchmark-runtime.mjs",
    "scripts/pilot-report.mjs",
    "dist/runtime/store.js",
    "dist/runtime/plan.js",
    "dist/runtime/service.js",
    "dist/runtime/executor.js",
    "dist/error-codes.js",
    "dist/presentation.js",
  ])
    h.update(file + "\0").update(
      fs.readFileSync(new URL("../" + file, import.meta.url)),
    );
  return h.digest("hex");
}
export async function profileCapacity(options) {
  const { size, ratio } = validateProfileOptions(options);
  const sourceDigest = digest();
  const samples = [];
  const recoverable = Math.floor(size * ratio),
    interrupted = Math.ceil(recoverable / 2),
    terminal = size - recoverable;
  for (const operation of ["list", "prune", "startup"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xiaohe-profile-"));
    let service;
    try {
      const setup = new RunStore(root);
      for (let i = 0; i < size; i++)
        setup.save(
          historyRecord(
            { parsePlan },
            i,
            i < interrupted
              ? "interrupted"
              : i < recoverable
                ? "running"
                : "succeeded",
          ),
        );
      const store = new RunStore(root);
      const measure = (op, fn) => {
        const before = store.diagnostics();
        const m = measureFsCalls(fn);
        const after = store.diagnostics();
        const diagnostics = Object.fromEntries(
          Object.keys(before).map((k) => [k, after[k] - before[k]]),
        );
        return {
          operation: op,
          failed: m.failed,
          wallTimeMs: m.failed ? null : m.wallTimeMs,
          calls: m.calls,
          diagnostics,
          returnedRecords: m.failed ? null : (m.value ?? null),
        };
      };
      const measured = [];
      measured.push(
        measure(operation, () => {
          if (operation === "list")
            return store.list(20, "benchmark-owner").length;
          if (operation === "prune") {
            store.prune(100);
            return null;
          }
          service = new RuntimeService({}, store);
          return null;
        }),
      );
      if (operation === "list")
        measured.push(
          measure("warm-list", () => store.list(20, "benchmark-owner").length),
        );
      // Verification is outside every instrumented window.
      const all = store.list(Number.MAX_SAFE_INTEGER);
      const kept = operation === "list" ? terminal : Math.min(100, terminal);
      const expected = {
        succeeded: kept,
        running: operation === "startup" ? 0 : recoverable - interrupted,
        interrupted: operation === "startup" ? recoverable : interrupted,
      };
      const states = Object.fromEntries(
        Object.keys(expected).map((s) => [
          s,
          all.filter((r) => r.state === s).length,
        ]),
      );
      const unknownSteps = all.reduce(
        (n, r) => n + r.steps.filter((s) => s.state === "unknown").length,
        0,
      );
      const verified =
        all.length === kept + recoverable &&
        Object.keys(expected).every((k) => states[k] === expected[k]) &&
        unknownSteps === (operation === "startup" ? recoverable : interrupted);
      for (const sample of measured) {
        sample.verified =
          verified &&
          ((sample.operation !== "list" && sample.operation !== "warm-list") ||
            sample.returnedRecords === Math.min(20, size));
        sample.failed ||= !sample.verified;
        if (sample.failed) sample.wallTimeMs = null;
        samples.push({
          ...sample,
          remaining: all.length,
          states,
          unknownSteps,
        });
      }
    } finally {
      try {
        if (service) await service.dispose();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }
  if (digest() !== sourceDigest) throw Error("PROFILE_SOURCE_CHANGED");
  return {
    version: 1,
    kind: "capacity-call-profile",
    config: { size, ratio },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      sourceDigest,
    },
    interpretation:
      "Instrumented synchronous JS fs API calls, NOT kernel syscall counts, CPU time or exclusive phases. Wrapped inclusive wall times overlap (writeFileSync can call open/close); do not sum or subtract from operation wall time. Setup, verification, disposal and cleanup excluded. Same process/module cache; fresh roots but NOT OS cold cache, machine exclusivity, production latency or model benefit. Counts include failed calls; failure timings remain diagnostic, not successful samples. Dedicated disposable process only; global builtin wrappers temporarily affect other callers.",
    failed: samples.filter((s) => s.failed).length,
    samples,
  };
}
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  Promise.resolve()
    .then(() => profileCapacity(parseProfileArgs(process.argv.slice(2))))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      if (report.failed) process.exitCode = 2;
    })
    .catch(() => {
      console.error("CAPACITY_PROFILE_FAILED");
      process.exitCode = 1;
    });
}
