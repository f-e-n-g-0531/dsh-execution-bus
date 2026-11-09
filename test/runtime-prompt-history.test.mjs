import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { BusinessPromptHistory } from "../dist/runtime/prompt-history.js";
import { BUSINESS_PROMPT_DEFAULTS, createBusinessPromptOverrides as create, previewBusinessPrompt as preview } from "../dist/runtime/prompt-preview.js";
import { promptHash } from "../dist/runtime/agent-trace.js";

const error = (code, fn) => assert.throws(fn, new RegExp("^Error: PROMPT_HISTORY_" + code + "$"));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, store: new BusinessPromptHistory(root),
    file: path.join(root, "business-prompt-history.json"),
    lock: path.join(root, ".business-prompt-history.lock"),
  };
}
const save = (store, expectedRevision = 0, overrides = create({ communication: "请用中文。" })) =>
  store.save({ expectedRevision, source: "host editor", overrides });
const offline = (value) => {
  assert.equal(value.applied, false);
  assert.equal(value.authorized, false);
  assert.equal(value.executable, false);
};
const disk = (f) => JSON.parse(fs.readFileSync(f.file, "utf8"));
const put = (f, value) => fs.writeFileSync(f.file, JSON.stringify(value));

test("empty history, detached snapshots, strict reload and newest-first summaries", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.store.read(), { revision: 0, items: [], applied: false, authorized: false, executable: false });
  error("NOT_FOUND", () => f.store.get(1));
  const input = create({ communication: "custom" });
  const first = save(f.store, 0, input);
  offline(first);
  assert.equal(first.revision, 1);
  assert.equal(first.previousRevision, null);
  assert.equal(first.previewRevision, preview({ overrides: input }).revision);
  input.communication.text = "caller mutation";
  first.overrides.communication.text = "result mutation";
  assert.equal(f.store.get(1).overrides.communication.text, "custom");
  const second = save(new BusinessPromptHistory(f.root), 1, {});
  assert.equal(second.previousRevision, 1);
  assert.ok(second.savedAt > first.savedAt);
  const read = f.store.read();
  offline(read);
  assert.deepEqual(read.items.map((x) => x.revision), [2, 1]);
  read.items.forEach(offline);
  assert.ok(read.items.every((x) => !Object.hasOwn(x, "overrides")));
  read.items[0].source = "mutated";
  assert.equal(f.store.history()[0].source, "host editor");
  const stored = disk(f);
  assert.deepEqual(Object.keys(stored).sort(), ["items", "version"]);
  assert.deepEqual(Object.keys(stored.items[0]).sort(), ["businessDefaults", "defaultsRevision", "overrides", "previewRevision", "previousRevision", "revision", "savedAt", "source"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
});

test("two store instances use CAS, preserve file on stale saves, never auto apply", (t) => {
  const f = fixture(t);
  const other = new BusinessPromptHistory(f.root);
  save(f.store);
  const before = fs.readFileSync(f.file);
  error("STALE_REVISION", () => save(other));
  assert.deepEqual(fs.readFileSync(f.file), before);
  offline(save(other, 1));
  assert.equal(f.store.read().revision, 2);
});

test("input validation rejects extra keys, unsafe numbers, controls, surrogates and getters", (t) => {
  const { store } = fixture(t);
  for (const value of [null, [], {}, { expectedRevision: 0, source: "host", overrides: {}, security: "bad" }])
    error("INVALID_INPUT", () => store.save(value));
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0"])
    error("INVALID_INPUT", () => save(store, value));
  for (const value of ["", " ", "x".repeat(257), "a\n", "a\t", "a\0", "a\u0085", "\ud800", "\udc00"])
    error("INVALID_INPUT", () => store.save({ expectedRevision: 0, source: value, overrides: {} }));
  for (const value of [null, { security: { text: "x", baseHash: "0".repeat(64) } },
    { communication: { text: "x", baseHash: "X".repeat(64) } },
    { communication: { text: "x", baseHash: "0".repeat(64), extra: true } },
    { communication: { text: "x".repeat(8193), baseHash: "0".repeat(64) } }])
    error("INVALID_INPUT", () => save(store, 0, value));
  let invoked = false;
  const raw = { expectedRevision: 0, source: "host", get overrides() { invoked = true; throw Error("private"); } };
  error("INVALID_INPUT", () => store.save(raw));
  assert.equal(invoked, false);
  for (const value of [0, -1, NaN, 1.5, "1"]) error("INVALID_INPUT", () => store.get(value));
  error("INVALID_INPUT", () => new BusinessPromptHistory("\0private"));
  error("INVALID_INPUT", () => new BusinessPromptHistory(" "));
});

test("strict persisted validation at every level never resets corrupt state", (t) => {
  const f = fixture(t);
  save(f.store);
  save(f.store, 1);
  const good = disk(f);
  const corruptions = [
    (x) => { x.extra = true; },
    (x) => { x.version = 2; },
    (x) => { x.items = []; },
    (x) => { x.items[0].extra = true; },
    (x) => { delete x.items[0].source; },
    (x) => { x.items[0].revision = 2; },
    (x) => { x.items[1].previousRevision = null; },
    (x) => { x.items[1].savedAt = x.items[0].savedAt; },
    (x) => { x.items[0].savedAt = Number.MAX_SAFE_INTEGER + 1; },
    (x) => { x.items[0].source = "\ud800"; },
    (x) => { x.items[0].defaultsRevision = "bad"; },
    (x) => { x.items[0].previewRevision = "0".repeat(64); },
    (x) => { x.items[0].overrides.security = {}; },
    (x) => { x.items[0].overrides.communication.extra = true; },
    (x) => { x.items[0].overrides.communication.baseHash = "bad"; },
    (x) => { x.items[0].overrides.communication.text = "changed without hash"; },
    (x) => { x.items.push(x.items[1]); },
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(good);
    corrupt(value);
    put(f, value);
    const before = fs.readFileSync(f.file);
    error("INVALID_STATE", () => new BusinessPromptHistory(f.root).read());
    error("INVALID_STATE", () => f.store.get(1));
    error("INVALID_STATE", () => save(f.store, 2));
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.existsSync(f.lock), false);
  }
  for (const raw of ["", "{broken", "null", "[]", Buffer.from([0xff])]) {
    fs.writeFileSync(f.file, raw);
    error("INVALID_STATE", () => f.store.read());
  }
});

test("original defaults and supplied baseline hashes survive defaults drift", (t) => {
  const f = fixture(t);
  save(f.store, 0, { communication: { text: "old override", baseHash: "1".repeat(64) } });
  const value = disk(f);
  value.items[0].defaultsRevision = "2".repeat(64);
  value.items[0].previewRevision = promptHash(JSON.stringify([value.items[0].defaultsRevision, value.items[0].overrides]));
  put(f, value);
  const historical = new BusinessPromptHistory(f.root).get(1);
  assert.equal(historical.defaultsRevision, "2".repeat(64));
  assert.equal(historical.overrides.communication.baseHash, "1".repeat(64));
  assert.notEqual(historical.defaultsRevision, preview().defaultsRevision);
  save(f.store, 1);
  assert.deepEqual(f.store.get(1), historical);
});

test("oversize is rejected before reading file bytes; crash locks stay fail closed", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, " ".repeat(1024 * 1024 + 1));
  const original = fs.default.readSync;
  let reads = 0;
  try {
    fs.default.readSync = (...args) => { reads++; return original(...args); };
    syncBuiltinESMExports();
    error("INVALID_STATE", () => f.store.read());
    error("INVALID_STATE", () => save(f.store));
    assert.equal(reads, 0);
  } finally { fs.default.readSync = original; syncBuiltinESMExports(); }
  fs.writeFileSync(f.lock, "stale crash lock");
  for (const action of [() => f.store.read(), () => f.store.get(1), () => save(f.store)]) error("BUSY", action);
  assert.equal(fs.readFileSync(f.lock, "utf8"), "stale crash lock");
});

test("failed atomic rename leaves old revision intact, no temp debris and sanitized error", (t) => {
  const f = fixture(t);
  save(f.store);
  const before = fs.readFileSync(f.file);
  const original = fs.default.renameSync;
  try {
    fs.default.renameSync = () => { throw Error("sensitive private path and text"); };
    syncBuiltinESMExports();
    error("STORAGE_FAILED", () => save(f.store, 1));
  } finally { fs.default.renameSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(f.root), ["business-prompt-history.json"]);
  assert.equal(save(f.store, 1).revision, 2);
});

test("temp write and fsync failures do not commit or leak IO text", (t) => {
  const f = fixture(t);
  save(f.store);
  const before = fs.readFileSync(f.file);
  for (const method of ["writeFileSync", "fsyncSync"]) {
    const original = fs.default[method];
    let calls = 0;
    try {
      fs.default[method] = (...args) => {
        if (++calls === 2) throw Error("sensitive IO failure");
        return original(...args);
      };
      syncBuiltinESMExports();
      error("STORAGE_FAILED", () => save(f.store, 1));
    } finally { fs.default[method] = original; syncBuiltinESMExports(); }
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.deepEqual(fs.readdirSync(f.root), ["business-prompt-history.json"]);
  }
});

test("exclusive lock and temp writes request 0600, fsync before rename", (t) => {
  const f = fixture(t);
  const originals = { openSync: fs.default.openSync, fsyncSync: fs.default.fsyncSync, renameSync: fs.default.renameSync };
  const events = [];
  try {
    fs.default.openSync = (...args) => { events.push(["open", ...args]); return originals.openSync(...args); };
    fs.default.fsyncSync = (...args) => { events.push(["fsync"]); return originals.fsyncSync(...args); };
    fs.default.renameSync = (...args) => { events.push(["rename"]); return originals.renameSync(...args); };
    syncBuiltinESMExports();
    save(f.store);
  } finally { Object.assign(fs.default, originals); syncBuiltinESMExports(); }
  const writes = events.filter((x) => x[0] === "open" && x[2] === "wx");
  assert.equal(writes.length, 2);
  assert.ok(writes.every((x) => x[3] === 0o600));
  assert.equal(events.filter((x) => x[0] === "fsync").length, 2);
  assert.equal(events.at(-1)[0], "rename");
});

test("history rejects revision 33 without eviction and preserves all 32 records", (t) => {
  const f = fixture(t);
  for (let index = 0; index < 32; index++) save(f.store, index, {});
  const before = fs.readFileSync(f.file);
  error("FULL", () => save(f.store, 32, {}));
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(f.store.history().length, 32);
  assert.equal(f.store.get(1).revision, 1);
  assert.equal(f.store.get(32).revision, 32);
  error("NOT_FOUND", () => f.store.get(33));
});

test("storage failures and directory masquerading as history are fail closed", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.file);
  error("INVALID_STATE", () => f.store.read());
  error("INVALID_STATE", () => save(f.store));
  const badRoot = path.join(f.root, "not-directory");
  fs.writeFileSync(badRoot, "private");
  error("STORAGE_FAILED", () => new BusinessPromptHistory(badRoot));
});

test("module exposes no model tools or integration entrypoints", async () => {
  const module = await import("../dist/runtime/prompt-history.js");
  assert.deepEqual(Object.keys(module), ["BusinessPromptHistory"]);
  for (const name of ["apply", "execute", "tool", "tools", "agent", "worker", "authorize"])
    assert.equal(BusinessPromptHistory.prototype[name], undefined);
});

test("runtime-owned defaults are persisted, detached and excluded from summaries", (t) => {
  const f = fixture(t);
  const first = save(f.store);
  for (const section of ["communication", "delivery"]) {
    assert.deepEqual(first.businessDefaults[section], {
      text: BUSINESS_PROMPT_DEFAULTS[section], hash: promptHash(BUSINESS_PROMPT_DEFAULTS[section]),
    });
  }
  assert.deepEqual(Object.keys(first.businessDefaults).sort(), ["communication", "delivery"]);
  assert.equal(Object.hasOwn(disk(f).items[0], "security"), false);
  first.businessDefaults.communication.text = "result mutation";
  const loaded = new BusinessPromptHistory(f.root).get(1);
  assert.equal(loaded.businessDefaults.communication.text, BUSINESS_PROMPT_DEFAULTS.communication);
  loaded.businessDefaults.delivery.hash = "0".repeat(64);
  assert.equal(f.store.get(1).businessDefaults.delivery.hash, promptHash(BUSINESS_PROMPT_DEFAULTS.delivery));
  for (const item of f.store.history()) {
    assert.equal(Object.hasOwn(item, "businessDefaults"), false);
    assert.equal(Object.hasOwn(item, "overrides"), false);
    assert.equal(JSON.stringify(item).includes(BUSINESS_PROMPT_DEFAULTS.communication), false);
  }
  const before = fs.readFileSync(f.file);
  error("INVALID_INPUT", () => f.store.save({ expectedRevision: 1, source: "host", overrides: {}, businessDefaults: first.businessDefaults }));
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("known unchanged baselines return before/current data without applying or writing", (t) => {
  const f = fixture(t);
  error("NOT_FOUND", () => f.store.defaultChanges(1));
  for (const revision of [0, -1, NaN, Infinity, 0.5, "1", Number.MAX_SAFE_INTEGER + 1])
    error("INVALID_INPUT", () => f.store.defaultChanges(revision));
  save(f.store);
  const before = fs.readFileSync(f.file);
  const result = f.store.defaultChanges(1);
  offline(result);
  assert.equal(result.revision, 1);
  assert.deepEqual(result.items.map((item) => item.section), ["communication", "delivery"]);
  for (const item of result.items) {
    assert.equal(item.status, "known");
    assert.equal(item.drifted, false);
    assert.equal(item.baseHash, item.currentHash);
    assert.equal(item.previousText, BUSINESS_PROMPT_DEFAULTS[item.section]);
    assert.equal(item.currentText, item.previousText);
    assert.notEqual(item.previousText, f.store.get(1).overrides.communication.text);
  }
  result.items[0].previousText = "mutated";
  result.items.push({ section: "security" });
  assert.equal(f.store.defaultChanges(1).items.length, 2);
  assert.equal(f.store.defaultChanges(1).items[0].previousText, BUSINESS_PROMPT_DEFAULTS.communication);
  assert.deepEqual(fs.readFileSync(f.file), before);
  error("STALE_REVISION", () => save(new BusinessPromptHistory(f.root), 0));
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test("legacy v1 records stay unknown, readable and unchanged across later saves", (t) => {
  const f = fixture(t);
  save(f.store);
  const legacy = disk(f);
  delete legacy.items[0].businessDefaults;
  put(f, legacy);
  const before = fs.readFileSync(f.file);
  assert.equal(Object.hasOwn(f.store.get(1), "businessDefaults"), false);
  const result = f.store.defaultChanges(1);
  offline(result);
  assert.equal(result.items[0].baseHash, promptHash(BUSINESS_PROMPT_DEFAULTS.communication));
  assert.equal(result.items[0].drifted, false);
  assert.equal(result.items[1].baseHash, null);
  assert.equal(result.items[1].drifted, null);
  for (const item of result.items) {
    assert.equal(item.status, "unknown");
    assert.equal(Object.hasOwn(item, "previousText"), false);
  }
  assert.deepEqual(fs.readFileSync(f.file), before);
  save(f.store, 1, {});
  assert.deepEqual(disk(f).items[0], legacy.items[0]);
  assert.equal(disk(f).version, 1);
  assert.ok(disk(f).items[1].businessDefaults);
  assert.ok(f.store.defaultChanges(1).items.every((item) => item.status === "unknown"));
});

test("unknown supplied base never borrows the current observed default", (t) => {
  const f = fixture(t);
  save(f.store, 0, { communication: { text: "override", baseHash: "1".repeat(64) } });
  const item = f.store.defaultChanges(1).items[0];
  assert.equal(item.baseHash, "1".repeat(64));
  assert.equal(item.currentHash, promptHash(BUSINESS_PROMPT_DEFAULTS.communication));
  assert.equal(item.status, "unknown");
  assert.equal(item.drifted, true);
  assert.equal(Object.hasOwn(item, "previousText"), false);
  assert.equal(f.store.defaultChanges(1).items[1].status, "known");
  // A hash observed only for the other section must not resolve this baseline.
  save(f.store, 1, { communication: { text: "override", baseHash: promptHash(BUSINESS_PROMPT_DEFAULTS.delivery) } });
  assert.equal(f.store.defaultChanges(2).items[0].status, "unknown");
});

test("upgrade simulation resolves old baseline by saved section hash across revisions", (t) => {
  const f = fixture(t);
  save(f.store, 0, {});
  const historical = disk(f);
  const oldText = "Earlier local business communication default.";
  const oldHash = promptHash(oldText);
  // Host-local files are not trusted provenance: legal edits simulate an older runtime.
  historical.items[0].businessDefaults.communication = { text: oldText, hash: oldHash };
  historical.items[0].defaultsRevision = "2".repeat(64);
  historical.items[0].previewRevision = promptHash(JSON.stringify([
    historical.items[0].defaultsRevision, historical.items[0].overrides,
  ]));
  put(f, historical);
  const first = f.store.defaultChanges(1).items[0];
  assert.equal(first.previousText, oldText);
  assert.equal(first.currentText, BUSINESS_PROMPT_DEFAULTS.communication);
  assert.equal(first.status, "known");
  assert.equal(first.drifted, true);
  save(f.store, 1, { communication: { text: "retained override", baseHash: oldHash } });
  assert.equal(f.store.get(2).businessDefaults.communication.hash, promptHash(BUSINESS_PROMPT_DEFAULTS.communication));
  const later = new BusinessPromptHistory(f.root).defaultChanges(2).items[0];
  assert.deepEqual(later, first);
  assert.notEqual(later.previousText, f.store.get(2).overrides.communication.text);
  assert.deepEqual(disk(f).items[0], historical.items[0]);
  assert.equal(f.store.defaultChanges(2).items[1].drifted, false);
});

test("optional defaults strictly reject malformed objects, hashes, text and security sections", (t) => {
  const f = fixture(t);
  save(f.store);
  const good = disk(f);
  const corruptions = [
    (x) => { x.businessDefaults = null; },
    (x) => { x.businessDefaults = []; },
    (x) => { delete x.businessDefaults.delivery; },
    (x) => { x.businessDefaults.security = { text: "private", hash: promptHash("private") }; },
    (x) => { x.businessDefaults.communication.extra = true; },
    (x) => { delete x.businessDefaults.communication.hash; },
    (x) => { x.businessDefaults.communication.hash = "X".repeat(64); },
    (x) => { x.businessDefaults.communication.hash = "0".repeat(64); },
    (x) => { x.businessDefaults.communication.text += "modified"; },
    ...[null, 42, "", " ", "a\0b", "\ud800", "\udc00", "x".repeat(8193)].map((text) => (x) => {
      x.businessDefaults.communication = { text, hash: promptHash(typeof text === "string" ? text : "invalid") };
    }),
  ];
  for (const corrupt of corruptions) {
    const value = structuredClone(good);
    corrupt(value.items[0]);
    put(f, value);
    const before = fs.readFileSync(f.file);
    for (const action of [() => f.store.get(1), () => f.store.read(), () => f.store.defaultChanges(1), () => save(f.store, 1)])
      error("INVALID_STATE", action);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.existsSync(f.lock), false);
  }
});
