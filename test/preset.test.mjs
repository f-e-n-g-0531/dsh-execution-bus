import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { load } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { Context } from "@deepseek-ai/cordis";
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
test("formal and legacy mode exports resolve to the same plugin module", async () => {
  const formal = await import("@feng0531/dsh-execution-bus/mode");
  const legacy = await import("@feng0531/dsh-execution-bus/test-mode");
  assert.equal(formal, legacy);
  assert.equal(formal.apply, legacy.apply);
});
