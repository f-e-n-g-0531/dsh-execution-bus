import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
test("completed duplicate requests reuse terminal results even with full host job capacity", async () => {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  const agent = { id: "reuse", session: { header: { cwd: process.cwd() } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({ maxConcurrentJobsPerOwner: 1 }));
  ctx.jobs.attachController("reuse-test");
  plugin.apply(scope.ctx);
  const events = [];
  ctx.jobs.events.subscribe({ owners: "all" }, (e) => events.push(e));
  const run = (args) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId: randomUUID(),
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  const message = (id, fail = false) => ({
    protocolVersion: 1,
    messageId: randomUUID(),
    requestId: id,
    type: "request",
    payload: { handler: "test", input: { delayMs: 0, fail } },
  });
  let release, blocker;
  try {
    const success = message("success"),
      failure = message("failure", true);
    assert.equal((await run(success)).value.state, "succeeded");
    assert.equal((await run(failure)).value.state, "failed");
    const done = new Promise((r) => (release = r));
    blocker = ctx.jobs.start({
      kind: "bash",
      label: "capacity fixture",
      owner: agent.id,
      run() {
        return {
          done,
          cancel() {
            release({ status: "killed" });
          },
        };
      },
    });
    const registered = events.filter((e) => e.type === "registered").length;
    for (const [m, state] of [
      [success, "succeeded"],
      [failure, "failed"],
    ]) {
      const result = await run({ ...m, messageId: randomUUID() });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.equal(result.value.state, state);
    }
    assert.equal(
      events.filter((e) => e.type === "registered").length,
      registered,
      "cached results must not create Jobs",
    );
    const conflict = await run({
      ...success,
      messageId: randomUUID(),
      payload: { handler: "test", input: { delayMs: 1, fail: false } },
    });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict), /REQUEST_CONFLICT/);
    const fresh = await run(message("new"));
    assert.equal(fresh.isError, true);
    assert.match(JSON.stringify(fresh), /HOST_JOB_UNAVAILABLE/);
  } finally {
    if (release) {
      release({ status: "completed" });
      await ctx.jobs.wait(blocker, 1000, agent.id);
      ctx.jobs.remove(blocker, agent.id);
    }
    await scope.dispose();
  }
});
