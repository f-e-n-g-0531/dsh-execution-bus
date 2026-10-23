import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as pwsh from "@deepseek-ai/dsh-tool-pwsh";
import * as plugin from "../dist/plugin.js";

const available =
  spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" })
    .status === 0;

// Real ToolRuntime + real pwsh tool + actual pwsh process. This bridge is not a sandbox provider.
async function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-pwsh-"));
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  process.env.XIAOHE_RUNTIME_DIR = dir;
  const ctx = new Context();
  const children = new Set();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  ctx.provide("workingDirectory");
  ctx.set("workingDirectory", {
    defaultDirectory: dir,
    get: () => dir,
    ensure: async () => dir,
  });
  ctx.provide("shellEnv");
  ctx.set("shellEnv", { collect: () => ({}) });
  ctx.provide("shell");
  ctx.set("shell", {
    resolve: (args) => ({
      ...args,
      workdir: args.workdir ?? dir,
      timeoutMs: args.timeoutMs ?? 10_000,
    }),
    async execute(spec) {
      const child = spawn(
        "pwsh",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", spec.command],
        {
          cwd: spec.workdir,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "",
        stderr = "",
        aborted = false,
        timedOut = false;
      const handle = {
        status: "running",
        exitCode: null,
        signal: null,
        kill: () => child.kill(),
      };
      const source = (get) => ({
        readFrom: (offset) => ({
          text: get().slice(offset),
          nextOffset: Buffer.byteLength(get()),
          lossy: false,
        }),
      });
      handle.observed = {
        stdout: source(() => stdout),
        stderr: source(() => stderr),
      };
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const abort = () => {
        aborted = true;
        child.kill();
      };
      spec.signal?.addEventListener("abort", abort, { once: true });
      let timer;
      if (spec.onExpiry !== "none")
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, spec.timeoutMs);
      handle.done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          handle.exitCode = code;
          handle.signal = signal;
          handle.status =
            aborted || timedOut || signal ? "killed" : "completed";
          resolve();
        });
      }).finally(() => {
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", abort);
        children.delete(handle);
      });
      handle.result = async () => {
        await handle.done;
        return {
          exitCode: handle.exitCode,
          signal: handle.signal,
          timedOut,
          aborted,
          timeoutMs: spec.timeoutMs,
          stdout: { text: stdout, truncated: false },
          stderr: { text: stderr, truncated: false },
        };
      };
      children.add(handle);
      if (spec.signal?.aborted) abort();
      return handle;
    },
  });
  let writes = 0;
  ctx.tools.register({
    name: "write",
    description: "observe",
    parameters: { type: "object", additionalProperties: true },
    output: { schema: {}, render: () => [] },
    execute() {
      writes++;
      return { ok: true };
    },
  });
  const agent = { id: "pwsh-owner", session: { header: { cwd: dir } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("runtime-pwsh-test");
  pwsh.apply(ctx, { enableRunInBackground: true, promoteOnTimeout: true });
  plugin.apply(scope.ctx);
  const call = (name, args) =>
    ctx.tools.execute({
      name,
      arguments: args,
      agent,
      callId: randomUUID(),
      signal: new AbortController().signal,
    });
  return {
    call,
    ctx,
    agent,
    writes: () => writes,
    async cleanup() {
      try {
        await scope.dispose();
        const pending = [...children];
        for (const handle of pending) handle.kill();
        await Promise.allSettled(pending.map((handle) => handle.done));
      } finally {
        if (previous === undefined) delete process.env.XIAOHE_RUNTIME_DIR;
        else process.env.XIAOHE_RUNTIME_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
function plan(command, timeoutMs = 10_000) {
  return {
    steps: [
      {
        id: "command",
        tool: "pwsh",
        input: {
          description: "Verify command completion semantics",
          command,
          timeoutMs,
        },
        timeout_ms: 20_000,
      },
      { id: "publish", tool: "write", input: {}, depends_on: ["command"] },
    ],
  };
}

test(
  "真实 pwsh 工具：非零退出不放行下游，零退出正常执行",
  { skip: !available, timeout: 30_000 },
  async () => {
    const f = await fixture();
    try {
      const failed = await f.call("runtime_run", { plan: plan("exit 1") });
      assert.equal(failed.isError, false, JSON.stringify(failed));
      assert.equal(failed.value.state, "failed");
      assert.equal(failed.value.steps[0].error, "RUNTIME_COMMAND_FAILED");
      assert.equal(f.writes(), 0);
      const passed = await f.call("runtime_run", { plan: plan("exit 0") });
      assert.equal(passed.isError, false, JSON.stringify(passed));
      assert.equal(passed.value.state, "succeeded");
      assert.equal(f.writes(), 1);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "真实 pwsh 自动转后台：保留 Job ID、阻止下游并显式收集停止任务",
  { skip: !available, timeout: 30_000 },
  async () => {
    const f = await fixture();
    let jobId;
    try {
      const result = await f.call("runtime_run", {
        plan: plan("Start-Sleep -Seconds 30", 1000),
      });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.value.state, "failed");
      assert.equal(result.value.steps[0].state, "unknown");
      assert.equal(
        result.value.steps[0].error,
        "RUNTIME_BACKGROUND_UNSUPPORTED",
      );
      assert.equal(f.writes(), 0);
      const stored = await f.call("runtime_result", {
        runId: result.value.runId,
      });
      jobId = stored.value.results.command.value.jobId;
      assert.equal(typeof jobId, "string");
    } finally {
      if (jobId) {
        f.ctx.jobs.kill(jobId, f.agent.id, "test cleanup");
        await f.ctx.jobs.wait(jobId, 10_000, f.agent.id);
        f.ctx.jobs.remove(jobId, f.agent.id);
      }
      await f.cleanup();
    }
  },
);
