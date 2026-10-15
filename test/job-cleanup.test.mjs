import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
async function fixture(body) {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  const agent = { id: "cleanup", session: { header: { cwd: process.cwd() } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("cleanup");
  plugin.apply(scope.ctx);
  const run = (args) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId: randomUUID(),
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  try {
    await body(ctx, agent, run);
  } finally {
    await scope.dispose();
  }
}
const message = (id, fail = false) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type: "request",
  payload: { handler: "test", input: { delayMs: 5, fail } },
});
test("settled Job removed by another subscriber does not override success or failure results", () =>
  fixture(async (ctx, agent, run) => {
    ctx.jobs.events.subscribe({ owners: "all" }, (e) => {
      if (e.type === "settled") ctx.jobs.remove(e.job.id, agent.id);
    });
    for (const fail of [false, true]) {
      const m = message("r" + fail, fail);
      const result = await run(m);
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.value.state, fail ? "failed" : "succeeded");
      const saved = await run({
        ...m,
        type: "result",
        messageId: randomUUID(),
        payload: {},
      });
      assert.equal(saved.value.delivery, "returned");
    }
    assert.equal(ctx.jobs.list(agent.id).length, 0);
  }));
test("unrelated cleanup service errors remain visible", () =>
  fixture(async (ctx, agent, run) => {
    const original = ctx.jobs.remove;
    ctx.jobs.remove = () => {
      throw Error("cleanup service unavailable");
    };
    try {
      const result = await run(message("error"));
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /cleanup service unavailable/);
    } finally {
      ctx.jobs.remove = original;
      for (const j of ctx.jobs.list(agent.id)) ctx.jobs.remove(j.id, agent.id);
    }
  }));
