import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-tools-"));
  process.env.XIAOHE_RUNTIME_DIR = dir;
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  const cwd = process.cwd();
  ctx.provide("workingDirectory");
  ctx.set("workingDirectory", {
    defaultDirectory: cwd,
    get: () => cwd,
    ensure: async () => cwd,
    set: async () => cwd,
  });
  const calls = { read: 0, pwsh: 0 };
  const stub = (name, run) => ({
    name,
    description: "stub " + name,
    parameters: { type: "object", additionalProperties: true },
    output: { schema: {}, render: () => [] },
    async execute(args) {
      calls[name]++;
      return run(args);
    },
  });
  ctx.tools.register(stub("read", async (args) => ({ content: "stub:" + args.file_path, truncated: false })));
  ctx.tools.register(stub("pwsh", async (args) => {
    await sleep(args.sleep ?? 0);
    return { stdout: "ok:" + args.command, exitCode: 0 };
  }));
  const agent = { id: "runtime-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("runtime-tools-test");
  plugin.apply(scope.ctx);
  const call = (name, args) =>
    ctx.tools.execute({
      name,
      callId: randomUUID(),
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  return { scope, call, calls, dir };
}

test("runtime_run 同步执行 DAG：并行只读步骤 + 依赖命令步骤", async () => {
  const { scope, call, calls, dir } = await fixture();
  try {
    const result = await call("runtime_run", {
      plan: {
        goal: "读取并汇总",
        concurrency: 2,
        steps: [
          { id: "a", tool: "read", input: { file_path: "a.txt" } },
          { id: "b", tool: "read", input: { file_path: "b.txt" } },
          { id: "c", tool: "pwsh", input: { description: "汇总", command: "echo ok" }, depends_on: ["a", "b"] },
        ],
      },
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.state, "succeeded");
    assert.deepEqual(result.value.steps.map((s) => s.state), ["succeeded", "succeeded", "succeeded"]);
    assert.equal(calls.read, 2);
    assert.equal(calls.pwsh, 1);
  } finally {
    await scope.dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XIAOHE_RUNTIME_DIR;
  }
});

test("runtime_run async + runtime_status/result 取回", async () => {
  const { scope, call, dir } = await fixture();
  try {
    const started = await call("runtime_run", {
      async: true,
      plan: {
        steps: [
          { id: "slow", tool: "pwsh", input: { description: "慢命令", command: "sleep", sleep: 250 } },
        ],
      },
    });
    assert.equal(started.isError, false, JSON.stringify(started));
    assert.equal(started.value.state, "running");
    assert.match(started.value.runId, /^run-/);
    let status = started.value;
    for (let i = 0; i < 50 && status.state === "running"; i++) {
      await sleep(20);
      const next = await call("runtime_status", { runId: started.value.runId });
      assert.equal(next.isError, false, JSON.stringify(next));
      status = next.value;
    }
    assert.equal(status.state, "succeeded");
    const result = await call("runtime_result", { runId: started.value.runId });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.deepEqual(result.value.results.slow.value, { stdout: "ok:sleep", exitCode: 0 });
  } finally {
    await scope.dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XIAOHE_RUNTIME_DIR;
  }
});

test("runtime 计划校验与跨工具未知字段拒绝", async () => {
  const { scope, call, dir } = await fixture();
  try {
    const bad = await call("runtime_run", {
      plan: { steps: [{ id: "a", tool: "host.read", input: { file_path: "x" } }] },
    });
    assert.equal(bad.isError, true);
    const badAsync = await call("runtime_run", {
      async: "yes",
      plan: { steps: [{ id: "a", tool: "read", input: { file_path: "x" } }] },
    });
    assert.equal(badAsync.isError, true);
    const status = await call("runtime_status", {});
    assert.equal(status.isError, false);
    assert.ok(Array.isArray(status.value.runs));
  } finally {
    await scope.dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XIAOHE_RUNTIME_DIR;
  }
});
