import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import {
  AgentPresetRegistry,
  entryListProblem,
} from "@deepseek-ai/dsh-agent-preset-registry";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as mode from "../dist/test-mode.js";
import LocalFS from "@deepseek-ai/dsh-fs-local";
const definition = parse(readFileSync("cordis.patch.yml", "utf8"))[0].insert[0]
  .config;
test("preset bundle declares a custom opt-in mode and no default/global bus change", () => {
  assert.equal(definition.id, "execution-bus-test");
  assert.equal(definition.name, "执行总线 / Execution Bus");
  assert.equal(entryListProblem(definition.plugins), undefined);
  assert.equal(
    definition.plugins.filter((r) => r.name.endsWith("/test-mode")).length,
    1,
  );
  assert.ok(!JSON.stringify(definition).includes("selectedDefault"));
  assert.throws(() => mode.apply(new Context()), /preset scope/);
});
test(
  "real preset registry mounts bus only for selected agents; default and ordinary agent unchanged",
  { timeout: 15000 },
  async () => {
    const ctx = new Context();
    new SystemPrompt(ctx, {});
    new ToolRuntime(ctx, { mode: "ptc" });
    new SessionProjectionRegistry(ctx);
    new LocalFS(ctx, LocalFS.Config({ cwd: process.cwd() }));
    new Jobs(ctx, Jobs.Config({}));
    new Loader(ctx, { baseUrl: pathToFileURL(process.cwd() + "/").href });
    const presets = new AgentPresetRegistry(
      ctx,
      AgentPresetRegistry.Config({ default: "standard" }),
    );
    const stopStandard = await presets.register({
      id: "standard",
      plugins: [],
    });
    const stop = await presets.register(definition);
    const row = (await presets.list()).find((p) => p.id === definition.id);
    assert.equal(row?.broken, undefined, JSON.stringify(row));
    assert.equal(presets.defaultId, "standard");
    const normalAgent = { id: "normal" },
      testAgent = { id: "selected" };
    const normal = createScope(ctx, normalAgent),
      selected = createScope(ctx, testAgent);
    normalAgent.ctx = normal.ctx;
    testAgent.ctx = selected.ctx;
    await presets.mount(normal.ctx, "standard");
    await presets.mount(selected.ctx, definition.id);
    try {
      assert.equal(ctx.tools.get("execution_bus", normalAgent), undefined);
      assert.ok(ctx.tools.get("execution_bus", testAgent));
      assert.equal(ctx.tools.modeFor(normalAgent), "ptc");
      assert.equal(ctx.tools.modeFor(testAgent), "native");
      assert.equal(ctx.tools.get("write", testAgent)?.name, "write");
      const denied = await ctx.tools.execute({
        name: "write",
        arguments: { file_path: "never-write", content: "no" },
        callId: "guard",
        agent: testAgent,
        signal: new AbortController().signal,
      });
      assert.equal(denied.isError, true);
      assert.match(JSON.stringify(denied), /allows only/);
    } finally {
      await selected.dispose();
      await normal.dispose();
      await stop();
      await stopStandard();
    }
  },
);
