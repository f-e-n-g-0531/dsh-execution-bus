import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

/**
 * Development-only synchronous-window fs attribution. Counts JS API calls and
 * probe-affected wall-clock wrapper time, not syscalls, CPU time, or exclusive
 * segments (nested fs calls can overlap). No arguments or errors are recorded.
 * Builtin bindings are patched process-wide only for the synchronous operation;
 * async/thenable results are unsupported and rejected after bindings restore.
 */
const methods = [
  "closeSync",
  "fstatSync",
  "mkdirSync",
  "openSync",
  "readdirSync",
  "readSync",
  "realpathSync",
  "renameSync",
  "rmSync",
  "writeFileSync",
];
let busy = false;

function probeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function measureFsCalls(operation) {
  if (busy) throw probeError("FS_PROBE_BUSY");
  if (typeof operation !== "function") {
    throw new TypeError("FS_PROBE_OPERATION_REQUIRED");
  }

  const calls = Object.fromEntries(
    methods.map((name) => [name, { calls: 0, failures: 0, totalMs: 0 }]),
  );
  const originals = new Map(methods.map((name) => [name, fs[name]]));
  let failed = false;
  let value;
  let wallTimeMs = 0;
  let asynchronous = false;
  busy = true;
  try {
    for (const name of methods) {
      const original = originals.get(name);
      const measurement = calls[name];
      fs[name] = function (...args) {
        measurement.calls += 1;
        const started = performance.now();
        try {
          return Reflect.apply(original, this, args);
        } catch (error) {
          measurement.failures += 1;
          throw error;
        } finally {
          measurement.totalMs += performance.now() - started;
        }
      };
    }
    syncBuiltinESMExports();
    const started = performance.now();
    try {
      value = operation();
      asynchronous =
        value !== null &&
        (typeof value === "object" || typeof value === "function") &&
        typeof value.then === "function";
    } catch {
      failed = true;
      value = undefined;
    } finally {
      wallTimeMs = performance.now() - started;
    }
  } finally {
    try {
      for (const [name, original] of originals) fs[name] = original;
      syncBuiltinESMExports();
    } finally {
      busy = false;
    }
  }
  if (asynchronous) throw probeError("FS_PROBE_ASYNC_UNSUPPORTED");
  return { failed, value, wallTimeMs, calls };
}
