import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { load } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { Context, Service } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import Registrar, { derivePreset, PRESET_ID } from "../dist/preset.js";
import * as mode from "../dist/mode.js";
test("bundle registers derived preset without altering default or original ptc", () => {
  const rows = parse(readFileSync("cordis.patch.yml", "utf8"));
  assert.equal(rows[0].insert[0].id, "preset-xiao-he-runtime");
  assert.equal(rows[0].insert[0].name, "@feng0531/dsh-execution-bus/preset");
  assert.ok(!JSON.stringify(rows).includes("selectedDefault"));
  assert.throws(() => mode.apply(new Context()), /preset scope/);
});
test("declaration derivation preserves nested config, disabled flags and host expression nodes", () => {
  const text =
    '- id: platform\n  name: "@deepseek-ai/dsh-tool-pwsh"\n  disabled: !!js process.platform !== "win32"\n- id: group\n  name: "@deepseek-ai/cordis-plugin-group"\n  group: true\n  config:\n    - id: manager\n      name: "@deepseek-ai/dsh-tool-cordis"\n      disabled: true\n';
  const source = load(text, { schema: entryListSchema });
  const definition = derivePreset(text);
  assert.deepEqual(definition.plugins.slice(0, -1), source);
  assert.equal(definition.id, PRESET_ID);
  assert.equal(definition.plugins.at(-1).name, "@feng0531/dsh-execution-bus/mode");
  assert.equal(definition.plugins.at(-1).id, "xiao-he-runtime");
  assert.equal(definition.name, "萧何 / Xiao He");
  assert.throws(() => derivePreset("invalid: mapping"), /Invalid PTC/);
  assert.throws(
    () => derivePreset('- id: recursive\n  name: "@feng0531/dsh-execution-bus/preset"'),
    /ALREADY_CONTAINS/,
  );
  assert.throws(
    () => derivePreset("- id: relative\n  name: ./local.js"),
    /RELATIVE_BASE_UNSUPPORTED/,
  );
});
test(
  "real registry derived composition keeps write tools and host denials without exposing runtime to original agent",
  { timeout: 15000 },
  async () => {
    const ctx = new Context();
    new SystemPrompt(ctx, {});
    new ToolRuntime(ctx, { mode: "native" });
    new SessionProjectionRegistry(ctx);
    ctx.provide("workingDirectory");
    ctx.set("workingDirectory", {
      defaultDirectory: process.cwd(),
      get: () => process.cwd(),
      ensure: async () => process.cwd(),
      set: async () => process.cwd(),
    });
    new LocalFS(ctx, LocalFS.Config({ cwd: process.cwd() }));
    new Jobs(ctx, Jobs.Config({}));
    new Loader(ctx, { baseUrl: pathToFileURL(process.cwd() + "/").href });
    const registry = new AgentPresetRegistry(ctx, AgentPresetRegistry.Config({ default: "ptc" }));
    const base = [
      { id: "files", name: "@deepseek-ai/dsh-tool-fs" },
      { id: "jobs", name: "@deepseek-ai/dsh-tool-jobs" },
    ];
    const original = await registry.register({ id: "ptc", plugins: base });
    const document = await registry.readDocument("ptc");
    const registrarScope = createScope(ctx, {});
    const fiber = registrarScope.ctx.plugin(Registrar);
    await fiber.await();
    const stop = () => registrarScope.dispose();
    const row = (await registry.list()).find((entry) => entry.id === PRESET_ID);
    assert.equal(row.broken, undefined, JSON.stringify(row));
    assert.equal(registry.defaultId, "ptc");
    assert.equal((await registry.readDocument("ptc")).content, document.content);
    const agent = { id: "selected", session: { header: { cwd: process.cwd() } } };
    const normalAgent = { id: "normal" };
    const selected = createScope(ctx, agent);
    const normal = createScope(ctx, normalAgent);
    agent.ctx = selected.ctx;
    normalAgent.ctx = normal.ctx;
    await registry.mount(selected.ctx, PRESET_ID);
    await registry.mount(normal.ctx, "ptc");
    await stop();
    try {
      assert.ok(ctx.tools.get("runtime_run", agent));
      assert.equal(ctx.tools.get("runtime_run", normalAgent), undefined);
      for (const name of ["read", "write", "edit", "job_list", "job_output", "job_kill"]) {
        assert.ok(ctx.tools.get(name, agent), name);
        assert.ok(ctx.tools.get(name, normalAgent), name);
      }
      const deny = ctx.on("tools/pre-execute", async (exec, next) =>
        exec.name === "write" ? { kind: "deny", reason: "host-policy-still-enforced" } : next(),
      );
      const result = await ctx.tools.execute({
        name: "write",
        arguments: { file_path: "never-write", content: "no" },
        agent,
        callId: "policy",
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /host-policy-still-enforced/);
      deny();
    } finally {
      await selected.dispose();
      await normal.dispose();
      await stop();
      await original();
    }
  },
);
test("preset derivation rejects invalid and unsafe declarations before registration", () => {
  const cases = [
    ["", /Invalid PTC/],
    ["null", /Invalid PTC/],
    ["- null", /Invalid PTC/],
    ["- name: ''", /Invalid PTC/],
    ["- name: 42", /Invalid PTC/],
    ["- name: group\n  group: true\n  config: {}", /Invalid PTC/],
    ["- name: [", /unexpected end/],
    ["- name: !!unknown value", /unknown tag/],
    ['- name: group\n  group: true\n  config:\n    - id: xiao-he-runtime\n      name: host', /ALREADY_CONTAINS/],
    ['- name: group\n  group: true\n  config:\n    - name: "@deepseek-ai/cordis-plugin-include"\n      disabled: true', /RELATIVE_BASE_UNSUPPORTED/],
    ['- name: "../host.js"', /RELATIVE_BASE_UNSUPPORTED/],
    ['- name: "@feng0531/dsh-execution-bus/mode"\n  disabled: true', /ALREADY_CONTAINS/],
    ['&rows\n- name: group\n  group: true\n  config: *rows', /cyclic plugin groups/],
    ['&rows\n- name: group\n  group: !!js true\n  config: *rows', /cyclic plugin groups/],
  ];
  for (const [content, error] of cases) assert.throws(() => derivePreset(content), error, content);
});

test("preset byte and group limits are bounded without rejecting shared acyclic aliases", () => {
  const base = '- name: host\n  config: "';
  const end = '"\n';
  const exact = base + "a".repeat(1048576 - Buffer.byteLength(base + end)) + end;
  assert.equal(Buffer.byteLength(exact), 1048576);
  assert.equal(derivePreset(exact).plugins[0].name, "host");
  assert.throws(() => derivePreset(exact + " "), /PTC_PRESET_TOO_LARGE/);
  assert.throws(() => derivePreset(base + "汉".repeat(349526) + end), /PTC_PRESET_TOO_LARGE/);
  assert.throws(() => derivePreset("- name: host\n".repeat(10001)), /traversal limit/);
  // Shallow YAML aliases exercise our graph-depth bound, not the YAML parser depth bound.
  let deep = "- name: group\n  group: true\n  config: &g0 []\n";
  for (let i = 1; i <= 66; i++) deep += "- name: group\n  group: true\n  config: &g" + i + " [{name: group, group: true, config: *g" + (i - 1) + "}]\n";
  assert.throws(() => derivePreset(deep), /traversal limit/);
  const shared = '- name: group\n  group: true\n  config: &children\n    - name: host\n- name: group\n  group: true\n  config: *children';
  assert.equal(derivePreset(shared).plugins.length, 3);
  assert.equal(derivePreset("[]").plugins.length, 1);
});

test("preset expressions are preserved as data, including arbitrary ordinary plugin config", () => {
  const key = "__xiaohePresetMustNotEvaluate";
  delete globalThis[key];
  const source = '- name: host\n  disabled: !!js globalThis.__xiaohePresetMustNotEvaluate = true\n  config:\n    name: ./not-a-plugin-row.js\n    group: true';
  assert.deepEqual(derivePreset(source).plugins.slice(0, -1), load(source, { schema: entryListSchema }));
  assert.equal(globalThis[key], undefined);
});

function registrar(readDocument, register = async () => () => {}) {
  return new Registrar({ agentPresets: { readDocument, register } })[Service.init]();
}
const missingPreset = () => Object.assign(new Error("not yet declared"), { code: "agent-preset/not-found" });

test("preset registrar retries only host not-found and yields the exact registration disposer", async () => {
  let reads = 0, registrations = 0;
  const dispose = () => {};
  const iterator = registrar(async (id) => {
    assert.equal(id, "ptc");
    if (++reads < 3) throw missingPreset();
    return { content: "- name: host" };
  }, async (definition) => {
    registrations++;
    assert.equal(definition.id, PRESET_ID);
    return dispose;
  });
  assert.deepEqual(await iterator.next(), { value: dispose, done: false });
  assert.equal((await iterator.next()).done, true);
  assert.equal(reads, 3);
  assert.equal(registrations, 1);
});

test("preset registrar propagates read/register failures and never registers unavailable or malformed declarations", async () => {
  for (const error of [new Error("registry unavailable"), { code: "agent-preset/not-found" }, "read failure"]) {
    let reads = 0, registrations = 0;
    const iterator = registrar(async () => { reads++; throw error; }, async () => { registrations++; });
    await assert.rejects(iterator.next(), (actual) => actual === error);
    assert.equal(reads, 1);
    assert.equal(registrations, 0);
  }
  for (const document of [undefined, null, { content: "invalid: mapping" }]) {
    let registrations = 0;
    await assert.rejects(registrar(async () => document, async () => { registrations++; }).next(), /PTC_PRESET_UNAVAILABLE|Invalid PTC/);
    assert.equal(registrations, 0);
  }
  const failure = new Error("register failed");
  await assert.rejects(registrar(async () => ({ content: "[]" }), async () => { throw failure; }).next(), (error) => error === failure);
});

test("preset registrar missing-host startup exhausts its bounded retry window", { timeout: 8000 }, async () => {
  let reads = 0, registrations = 0;
  await assert.rejects(registrar(async () => { reads++; throw missingPreset(); }, async () => { registrations++; }).next(), /requires a declared ptc preset/);
  assert.equal(reads, 50);
  assert.equal(registrations, 0);
});

test("formal and legacy mode exports resolve to the same plugin module", async () => {
  const formal = await import("@feng0531/dsh-execution-bus/mode");
  const legacy = await import("@feng0531/dsh-execution-bus/test-mode");
  assert.equal(formal, legacy);
  assert.equal(formal.apply, legacy.apply);
});
