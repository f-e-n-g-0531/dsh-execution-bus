import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as fileTools from "@deepseek-ai/dsh-tool-fs";
import * as plugin from "../dist/plugin.js";

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
  fileTools.apply(ctx, fileTools.Config({}));
  const agent = { id: "simplified-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("simplified-input-test");
  plugin.apply(scope.ctx);
  const run = (args, signal = new AbortController().signal) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId: randomUUID(),
      arguments: args,
      agent,
      signal,
    });
  return { ctx, agent, scope, run };
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const fullRequest = (requestId, handler, input) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId,
  type: "request",
  payload: { handler, input },
});

test("简化请求 {requestId,handler,input} 自动补 messageId 并执行", async () => {
  const { scope, run } = await fixture();
  try {
    const r = await run({ requestId: "simple-read", handler: "host.read", input: { file_path: "package.json", limit: 1 } });
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.state, "succeeded");
    assert.match(JSON.stringify(r.value.result), /dsh-execution-bus/);
    assert.equal(r.value.reused, undefined);
  } finally {
    await scope.dispose();
  }
});

test("简化控制 {requestId,type} 可查询；终态复用返回 reused:true", async () => {
  const { scope, run } = await fixture();
  try {
    const first = await run({ requestId: "simple-reuse", handler: "host.read", input: { file_path: "package.json", limit: 1 } });
    assert.equal(first.value.state, "succeeded");
    assert.equal(first.value.reused, undefined);
    const status = await run({ requestId: "simple-reuse", type: "status" });
    assert.equal(status.isError, false, JSON.stringify(status));
    assert.equal(status.value.state, "succeeded");
    const again = await run({ requestId: "simple-reuse", handler: "host.read", input: { file_path: "package.json", limit: 1 } });
    assert.equal(again.value.state, "succeeded");
    assert.equal(again.value.reused, true);
  } finally {
    await scope.dispose();
  }
});

test("运行中的同 requestId 重发只等待原执行并返回 reused:true", async () => {
  const { scope, run } = await fixture();
  try {
    const first = run({ requestId: "simple-running", handler: "test", input: { delayMs: 120, fail: false } });
    await pause(20);
    const second = await run({ requestId: "simple-running", handler: "test", input: { delayMs: 120, fail: false } });
    const firstResult = await first;
    assert.equal(firstResult.isError, false, JSON.stringify(firstResult));
    assert.equal(second.isError, false, JSON.stringify(second));
    assert.equal(second.value.state, "succeeded");
    assert.equal(second.value.reused, true);
  } finally {
    await scope.dispose();
  }
});

test("完整 v1 消息仍被接受（向后兼容）", async () => {
  const { scope, run } = await fixture();
  try {
    const r = await run(fullRequest("full-envelope", "test", { delayMs: 5, fail: false }));
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.state, "succeeded");
    assert.deepEqual(r.value.result, { ok: true });
  } finally {
    await scope.dispose();
  }
});

test("简化形状的未知字段、handler/type 混杂与缺 requestId 被拒绝", async () => {
  const { scope, run } = await fixture();
  try {
    const cases = [
      { requestId: "x", handler: "host.read", input: { file_path: "package.json" }, extra: 1 },
      { requestId: "x", handler: "host.read", input: {}, type: "result" },
      { handler: "host.read", input: {} },
      { requestId: "x", type: "unknown" },
      { requestId: "x" },
    ];
    for (const args of cases) {
      const r = await run(args);
      assert.equal(r.isError, true, JSON.stringify({ args, r }));
      assert.match(JSON.stringify(r), /INVALID_REQUEST/);
    }
  } finally {
    await scope.dispose();
  }
});
