import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import * as fileTools from "@deepseek-ai/dsh-tool-fs";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
import { randomUUID } from "node:crypto";
const message = (handler, input, id = randomUUID()) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type: "request",
  payload: { handler, input },
});
test("real Cordis ToolRuntime + LocalJobs + read tool component smoke (not model/GUI)", async () => {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  const agent = {
    id: "isolated-session",
    session: { header: { cwd: process.cwd() } },
  };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("execution-bus-component-test");
  new LocalFS(ctx, LocalFS.Config({ cwd: process.cwd() }));
  // 0.2.1-rc.2 起宿主要求 workingDirectory 服务；夹具 Agent 无法构造真实 Session 投影，
  // 这里注入与宿主工具链兼容的最小 stub（只读场景），不改变被测插件逻辑。
  ctx.provide("workingDirectory");
  ctx.set("workingDirectory", {
    defaultDirectory: process.cwd(),
    get: () => process.cwd(),
    ensure: async () => process.cwd(),
    set: async () => process.cwd(),
  });
  fileTools.apply(ctx, fileTools.Config({}));
  plugin.apply(scope.ctx);
  const events = [];
  ctx.jobs.events.subscribe({ owners: "all" }, (e) => events.push(e));
  const run = (
    args,
    callId = randomUUID(),
    signal = new AbortController().signal,
  ) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId,
      arguments: args,
      agent,
      signal,
    });
  const result = await run(
    message("host.read", { file_path: "package.json", limit: 2 }),
    "original-call",
  );
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.state, "succeeded");
  assert.ok(
    JSON.stringify(result.value.result).includes("@feng0531/dsh-execution-bus"),
  );
  const slow = await run(message("test", { delayMs: 40, fail: false }));
  assert.equal(slow.value.state, "succeeded");
  assert.ok(events.some((e) => e.type === "progress"));
  assert.ok(events.filter((e) => e.type === "settled").every((e) => e.awaited));
  assert.equal(ctx.jobs.list(agent.id).length, 0);
  const deny = ctx.on("tools/pre-execute", async (exec, next) =>
    exec.name === "read" ? { kind: "deny", reason: "test deny" } : next(),
  );
  const denied = await run(
    message("host.read", { file_path: "package.json", limit: 1 }),
  );
  assert.equal(denied.value.state, "failed");
  deny();
  const anonymous = await ctx.tools.execute({
    name: "execution_bus",
    callId: "anonymous",
    arguments: message("test", { delayMs: 1, fail: false }),
    signal: new AbortController().signal,
  });
  assert.equal(anonymous.isError, true);
  const duplicate = message("test", { delayMs: 20, fail: false });
  const registeredBefore = events.filter((e) => e.type === "registered").length;
  const repeated = await Promise.all([
    run(duplicate),
    run({ ...duplicate, messageId: randomUUID() }),
  ]);
  assert.ok(repeated.every((r) => !r.isError && r.value.state === "succeeded"));
  assert.equal(
    events.filter((e) => e.type === "registered").length - registeredBefore,
    1,
    "duplicate attachments must share one host Job",
  );
  const state = await ctx.tools.execute({
    name: "execution_bus_state",
    arguments: {},
    agent,
    callId: "state-query",
    signal: new AbortController().signal,
  });
  assert.equal(state.isError, false, JSON.stringify(state));
  assert.equal(state.value.policy.sessionQueueLimit, 16);
  assert.equal(state.value.policy.maxQueueWaitMs, 120000);
  assert.ok(
    state.value.tasks.every(
      (task) => !("result" in task) && !("input" in task),
    ),
  );
  const forged = await ctx.tools.execute({
    name: "execution_bus_state",
    arguments: { sessionId: "other" },
    agent,
    callId: "forged",
    signal: new AbortController().signal,
  });
  assert.equal(forged.isError, true);
  const anonymousState = await ctx.tools.execute({
    name: "execution_bus_state",
    arguments: {},
    callId: "anonymous-state",
    signal: new AbortController().signal,
  });
  assert.equal(anonymousState.isError, true);
  const controller = new AbortController();
  const aborted = run(
    message("test", { delayMs: 1000, fail: false }),
    "abort-call",
    controller.signal,
  );
  controller.abort();
  assert.equal((await aborted).isError, true);
  const pending = run(message("test", { delayMs: 1000, fail: false }));
  await new Promise((r) => setTimeout(r, 5));
  await scope.dispose();
  const unloaded = await pending;
  assert.ok(unloaded.isError || unloaded.value.state === "cancelled");
  assert.equal(ctx.tools.get("execution_bus", agent), undefined);
});
