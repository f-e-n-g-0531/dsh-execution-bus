import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import Subprocess from "@deepseek-ai/dsh-subprocess-local";
import NodePtc from "@deepseek-ai/dsh-ptc-runtime-node";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as files from "@deepseek-ai/dsh-tool-fs";
import * as mode from "../dist/mode.js";

/** 真实 Node PTC run_code：验证预算到期与外部中断在宿主中断原因上的差异，
 *  以及已受理总线执行在预算到期后继续、可被同会话取回。 */
async function fixture() {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  ctx.provide("workingDirectory");
  ctx.set("workingDirectory", {
    defaultDirectory: process.cwd(),
    get: () => process.cwd(),
    ensure: async () => process.cwd(),
    set: async () => process.cwd(),
  });
  new LocalFS(ctx, LocalFS.Config({ cwd: process.cwd() }));
  new Subprocess(ctx);
  ctx.provide("sandboxPolicy");
  ctx.set("sandboxPolicy", {
    defaultMode: "danger-full-access",
    resolve: () => ({ mode: "danger-full-access", workspaceRoot: process.cwd() }),
  });
  ctx.provide("sandbox");
  ctx.set("sandbox", {
    confine() {
      throw Error("fixture has no confinement backend");
    },
  });
  new NodePtc(ctx, NodePtc.Config({ timeoutMs: 2000, maxTimeoutMs: 10000 }));
  const agent = {
    id: "ptc-detached",
    session: { header: { cwd: process.cwd() }, append() {} },
  };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("ptc-detached-test");
  files.apply(scope.ctx, files.Config({}));
  scope.ctx.tools.presentAs("ptc");
  mode.apply(scope.ctx);
  const run = (args, signal = new AbortController().signal) =>
    ctx.tools.execute({
      name: "run_code",
      callId: "call-" + Math.random().toString(16).slice(2),
      arguments: args,
      agent,
      signal,
    });
  // PTC 呈现下只有 run_code 可直接调用；控制消息也必须在程序内发出。
  // 外层中断可能令常驻 PTC 子进程重启，控制调用按短暂重试处理宿主瞬时失败。
  const control = async (type, requestId, attempts = 6) => {
    const message = JSON.stringify({
      protocolVersion: 1,
      messageId: "cm-" + Math.random().toString(16).slice(2),
      requestId,
      type,
      payload: {},
    });
    let last;
    for (let i = 0; i < attempts; i++) {
      const r = await run({
        code: "return await tools.execution_bus(" + message + ");",
        description: "bus " + type,
      });
      if (!r.isError) return { isError: false, value: r.value.result };
      last = r;
      await pause(120);
    }
    return last;
  };
  return { ctx, agent, scope, run, control };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** 已受理执行的可见证据：插件已创建宿主 Job。用它避免在受理前中断造成竞态。 */
async function waitJob(ctx, agent, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ctx.jobs.list(agent.id).length > 0) return true;
    await pause(10);
  }
  return false;
}
async function waitState(control, id, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const r = await control("status", id);
    if (r.isError) return r;
    last = r;
    if (expected.includes(r.value.state)) return r;
    await pause(30);
  }
  return last;
}

test(
  "真实 PTC 预算到期：已受理总线执行继续并可用同 requestId 取回",
  { timeout: 20000 },
  async () => {
    const { ctx, agent, scope, run, control } = await fixture();
    try {
      const result = await run({
        code: 'return await tools.execution_bus({protocolVersion:1,messageId:"m1",requestId:"ptc-detach",type:"request",payload:{handler:"test",input:{delayMs:5000,fail:false}}});',
        description: "bus wait exceeds run_code budget",
      });
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.match(JSON.stringify(result), /timeout/, JSON.stringify(result));
      assert.equal(await waitJob(ctx, agent), true, "execution was not accepted before budget expiry");
      const seen = await waitState(control, "ptc-detach", ["queued", "running"]);
      assert.equal(seen.isError, false, JSON.stringify(seen));
      const done = await waitState(control, "ptc-detach", ["succeeded"], 8000);
      assert.equal(done.value.state, "succeeded", JSON.stringify(done.value));
      assert.deepEqual(done.value.result, { ok: true });
    } finally {
      await scope.dispose();
    }
  },
);

test(
  "真实 PTC 外部中断：仍请求取消已受理执行",
  { timeout: 20000 },
  async () => {
    const { ctx, agent, scope, run, control } = await fixture();
    try {
      const outer = new AbortController();
      const pending = run(
        {
          code: 'return await tools.execution_bus({protocolVersion:1,messageId:"m2",requestId:"ptc-cancel",type:"request",payload:{handler:"test",input:{delayMs:5000,fail:false}}});',
          description: "bus wait interrupted by user",
        },
        outer.signal,
      );
      // 等到宿主 Job 出现（= 总线已受理）再中断，避免“受理前中断”的测试竞态。
      assert.equal(await waitJob(ctx, agent), true, "execution was not accepted before abort");
      await pause(50);
      outer.abort("user cancelled the run");
      const result = await pending;
      assert.equal(result.isError, true, JSON.stringify(result));
      await pause(200);
      const cancelled = await waitState(control, "ptc-cancel", ["cancelled"], 6000);
      assert.equal(cancelled.isError, false, JSON.stringify(cancelled));
      assert.equal(cancelled.value.state, "cancelled", JSON.stringify(cancelled.value));
    } finally {
      await scope.dispose();
    }
  },
);
