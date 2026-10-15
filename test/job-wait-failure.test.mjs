import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
for (const cleanupFails of [false, true])
  test(
    "wait failure drains original execution before reporting error; cleanup failure=" +
      cleanupFails,
    async () => {
      const ctx = new Context();
      new SystemPrompt(ctx, {});
      new ToolRuntime(ctx, {});
      const agent = {
        id: "wait-failure",
        session: { header: { cwd: process.cwd() } },
      };
      const scope = createScope(ctx, agent);
      agent.ctx = scope.ctx;
      ctx.provide("agents");
      ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
      new Jobs(ctx, Jobs.Config({}));
      ctx.jobs.attachController("test");
      plugin.apply(scope.ctx);
      const wait = ctx.jobs.wait,
        remove = ctx.jobs.remove;
      ctx.jobs.wait = async () => {
        throw Error("original wait failure");
      };
      if (cleanupFails)
        ctx.jobs.remove = () => {
          throw Error("secondary cleanup failure");
        };
      const m = {
        protocolVersion: 1,
        messageId: "m",
        requestId: "r",
        type: "request",
        payload: { handler: "test", input: { delayMs: 80, fail: false } },
      };
      const run = (args) =>
        ctx.tools.execute({
          name: "execution_bus",
          callId: crypto.randomUUID(),
          arguments: args,
          agent,
          signal: new AbortController().signal,
        });
      try {
        const result = await run(m);
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /original wait failure/);
        assert.ok(
          !JSON.stringify(result).includes("secondary cleanup failure"),
        );
        const state = await run({
          ...m,
          messageId: "status",
          type: "status",
          payload: {},
        });
        assert.equal(state.value.state, "succeeded");
        assert.equal(state.value.delivery, "pending");
        assert.equal(state.value.cancelRequested, false);
        if (!cleanupFails) assert.equal(ctx.jobs.list(agent.id).length, 0);
      } finally {
        ctx.jobs.wait = wait;
        ctx.jobs.remove = remove;
        await scope.dispose();
      }
    },
  );
