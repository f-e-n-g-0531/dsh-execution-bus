import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";

/** DSH 0.2.1-rc.2 的 PTC 在程序结束/预算到期时以固定字符串中断子调用；
 *  测试直接以同一原因 abort 外层工具调用，验证分离等待语义。 */
const PTC_END = "run_code settled";

async function fixture() {
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
  new LocalFS(ctx, LocalFS.Config({ cwd }));
  const calls = [];
  ctx.tools.register({
    name: "pwsh",
    description: "stub slow pwsh",
    parameters: { type: "object", additionalProperties: true },
    output: { schema: {}, render: () => [] },
    async execute(args) {
      calls.push(args);
      await new Promise((resolve) => setTimeout(resolve, 250));
      return {
        kind: "foreground",
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: 120000,
        stdout: { text: "slow done", truncated: false },
        stderr: { text: "", truncated: false },
      };
    },
  });
  const agent = { id: "detach-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("detached-budget-test");
  plugin.apply(scope.ctx);
  const run = (args, signal = new AbortController().signal, agentOverride = agent) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId: randomUUID(),
      arguments: args,
      agent: agentOverride,
      signal,
    });
  return { ctx, agent, scope, run, calls };
}

const request = (handler, input, id = randomUUID()) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type: "request",
  payload: { handler, input },
});
const control = (type, id) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type,
  payload: {},
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitState(run, id, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const r = await run(control("status", id));
    if (r.isError) return r;
    last = r;
    if (expected.includes(r.value.state)) return r;
    await pause(20);
  }
  return last;
}

test("PTC 程序结束只停止等待：已受理执行继续并可用同 requestId 取回", async () => {
  const { scope, run } = await fixture();
  try {
    const controller = new AbortController();
    const outer = run(
      request("test", { delayMs: 250, fail: false }, "detach-test"),
      controller.signal,
    );
    await pause(30);
    controller.abort(PTC_END);
    const aborted = await outer;
    assert.equal(aborted.isError, true, JSON.stringify(aborted));
    // 未被连带取消：仍在排队/运行，最终完成并可取回结果。
    const running = await waitState(run, "detach-test", ["queued", "running"]);
    assert.ok(running.isError === false, JSON.stringify(running));
    const done = await waitState(run, "detach-test", ["succeeded"]);
    assert.equal(done.isError, false, JSON.stringify(done));
    assert.equal(done.value.state, "succeeded");
    assert.deepEqual(done.value.result, { ok: true });
  } finally {
    await scope.dispose();
  }
});

test("分离等待后宿主 Job 保留到执行完成再释放", async () => {
  const { ctx, agent, scope, run } = await fixture();
  try {
    const controller = new AbortController();
    const outer = run(
      request("test", { delayMs: 200, fail: false }, "detach-job"),
      controller.signal,
    );
    await pause(30);
    controller.abort(PTC_END);
    await outer;
    assert.equal(ctx.jobs.list(agent.id).length, 1, "projection must survive detach");
    const done = await waitState(run, "detach-job", ["succeeded"]);
    assert.equal(done.value.state, "succeeded");
    const deadline = Date.now() + 2000;
    while (ctx.jobs.list(agent.id).length !== 0 && Date.now() < deadline)
      await pause(20);
    assert.equal(ctx.jobs.list(agent.id).length, 0);
  } finally {
    await scope.dispose();
  }
});

test("分离等待后执行仍可调用宿主工具完成剩余工作", async () => {
  const { scope, run, calls } = await fixture();
  try {
    const controller = new AbortController();
    const outer = run(
      request(
        "host.pwsh",
        { description: "slow command", command: "Start-Sleep -Milliseconds 250" },
        "detach-pwsh",
      ),
      controller.signal,
    );
    await pause(30);
    controller.abort(PTC_END);
    assert.equal((await outer).isError, true);
    const done = await waitState(run, "detach-pwsh", ["succeeded"]);
    assert.equal(done.isError, false, JSON.stringify(done));
    assert.equal(done.value.state, "succeeded");
    assert.equal(done.value.result.stdout.text, "slow done");
    assert.equal(calls.length, 1);
  } finally {
    await scope.dispose();
  }
});

test("分离等待后重发同 requestId 会等待原执行并取得结果", async () => {
  const { scope, run } = await fixture();
  try {
    const controller = new AbortController();
    const outer = run(
      request("test", { delayMs: 300, fail: false }, "detach-reattach"),
      controller.signal,
    );
    await pause(30);
    controller.abort(PTC_END);
    await outer;
    const again = await run(
      request("test", { delayMs: 300, fail: false }, "detach-reattach"),
    );
    assert.equal(again.isError, false, JSON.stringify(again));
    assert.equal(again.value.state, "succeeded");
    assert.deepEqual(again.value.result, { ok: true });
  } finally {
    await scope.dispose();
  }
});

test("用户/会话中断仍请求取消整个执行", async () => {
  const { scope, run } = await fixture();
  try {
    const controller = new AbortController();
    const outer = run(
      request("test", { delayMs: 500, fail: false }, "user-cancel"),
      controller.signal,
    );
    await pause(30);
    controller.abort("user cancelled the turn");
    assert.equal((await outer).isError, true);
    const cancelled = await waitState(run, "user-cancel", ["cancelled"]);
    assert.equal(cancelled.isError, false, JSON.stringify(cancelled));
    assert.equal(cancelled.value.state, "cancelled");
  } finally {
    await scope.dispose();
  }
});

test("无原因的默认中断按取消处理，不错误地分离等待", async () => {
  const { scope, run } = await fixture();
  try {
    const controller = new AbortController();
    const outer = run(
      request("test", { delayMs: 500, fail: false }, "default-abort"),
      controller.signal,
    );
    await pause(30);
    controller.abort();
    assert.equal((await outer).isError, true);
    const cancelled = await waitState(run, "default-abort", ["cancelled"]);
    assert.equal(cancelled.value.state, "cancelled");
  } finally {
    await scope.dispose();
  }
});
