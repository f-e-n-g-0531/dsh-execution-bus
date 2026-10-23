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
  const calls = { read: 0, pwsh: 0, write: 0 };
  const stub = (name, run) => ({
    name,
    description: "stub " + name,
    parameters: { type: "object", additionalProperties: true },
    output: { schema: {}, render: () => [] },
    async execute(args, exec) {
      calls[name]++;
      return run(args, exec);
    },
  });
  ctx.tools.register(
    stub("read", async (args) => ({
      content: "stub:" + args.file_path,
      truncated: false,
    })),
  );
  ctx.tools.register(
    stub("pwsh", async (args) => {
      await sleep(args.sleep ?? 0);
      return { stdout: "ok:" + args.command, exitCode: 0 };
    }),
  );
  ctx.tools.register(stub("write", async () => ({ ok: true })));
  const agent = { id: "runtime-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  const agents = new Map([[agent.id, agent]]);
  ctx.set("agents", { get: (id) => agents.get(id) });
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
  const peer = () => {
    const other = { id: "peer-agent", session: { header: { cwd } } };
    const otherScope = createScope(ctx, other);
    other.ctx = otherScope.ctx;
    agents.set(other.id, other);
    plugin.apply(otherScope.ctx);
    return {
      scope: otherScope,
      call: (name, args) =>
        ctx.tools.execute({
          name,
          arguments: args,
          agent: other,
          callId: randomUUID(),
          signal: new AbortController().signal,
        }),
    };
  };
  return { scope, call, calls, dir, ctx, peer };
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
          {
            id: "c",
            tool: "pwsh",
            input: { description: "汇总", command: "echo ok" },
            depends_on: ["a", "b"],
          },
        ],
      },
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.state, "succeeded");
    assert.deepEqual(
      result.value.steps.map((s) => s.state),
      ["succeeded", "succeeded", "succeeded"],
    );
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
          {
            id: "slow",
            tool: "pwsh",
            input: { description: "慢命令", command: "sleep", sleep: 250 },
          },
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
    assert.deepEqual(result.value.results.slow.value, {
      stdout: "ok:sleep",
      exitCode: 0,
    });
  } finally {
    await scope.dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XIAOHE_RUNTIME_DIR;
  }
});

test("runtime_run 内嵌写入仍经过宿主拒绝管线", async () => {
  const { scope, call, calls, dir, ctx } = await fixture();
  let nested = false;
  const deny = ctx.on("tools/pre-execute", async (exec, next) => {
    if (exec.name === "write") {
      nested = exec.parent !== undefined;
      return { kind: "deny", reason: "nested-write-denied" };
    }
    return next();
  });
  try {
    const run = await call("runtime_run", {
      plan: {
        steps: [
          {
            id: "blocked",
            tool: "write",
            input: { file_path: "never-write", content: "no" },
          },
          {
            id: "child",
            tool: "pwsh",
            input: { description: "never", command: "exit 0" },
            depends_on: ["blocked"],
          },
        ],
      },
    });
    assert.equal(run.isError, false, JSON.stringify(run));
    assert.equal(run.value.state, "failed");
    assert.equal(run.value.steps[0].error, "RUNTIME_STEP_FAILED");
    assert.equal(nested, true);
    assert.equal(calls.write, 0);
    assert.equal(calls.pwsh, 0);
  } finally {
    deny();
    await scope.dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XIAOHE_RUNTIME_DIR;
  }
});

test("真实 ToolRuntime 双作用域：另一会话不能读取结果、取消或恢复", async () => {
  const f = await fixture();
  const other = f.peer();
  try {
    const owner = await f.call("runtime_run", {
      plan: {
        steps: [
          { id: "file", tool: "read", input: { file_path: "private-marker" } },
        ],
      },
    });
    assert.equal(owner.isError, false, JSON.stringify(owner));
    for (const tool of [
      "runtime_status",
      "runtime_result",
      "runtime_cancel",
      "runtime_resume",
    ]) {
      const denied = await other.call(tool, { runId: owner.value.runId });
      assert.equal(denied.isError, true, tool);
      assert.match(JSON.stringify(denied), /RUNTIME_NOT_FOUND/);
      assert.doesNotMatch(JSON.stringify(denied), /private-marker/);
    }
    const listed = await other.call("runtime_status", {});
    assert.equal(listed.isError, false, JSON.stringify(listed));
    assert.deepEqual(listed.value.runs, []);
    assert.equal(
      (await f.call("runtime_result", { runId: owner.value.runId })).value
        .state,
      "succeeded",
    );
  } finally {
    await other.scope.dispose();
    await f.scope.dispose();
    rmSync(f.dir, { recursive: true, force: true });
    delete process.env.XIAOHE_RUNTIME_DIR;
  }
});

test("runtime 计划校验与跨工具未知字段拒绝", async () => {
  const { scope, call, dir } = await fixture();
  try {
    const bad = await call("runtime_run", {
      plan: {
        steps: [{ id: "a", tool: "host.read", input: { file_path: "x" } }],
      },
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
