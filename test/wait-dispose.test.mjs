import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
test(
  "wait failure followed by scope disposal settles original call and disposal",
  { timeout: 4000 },
  async () => {
    const ctx = new Context();
    new SystemPrompt(ctx, {});
    new ToolRuntime(ctx, {});
    const agent = {
      id: "dispose-race",
      session: { header: { cwd: process.cwd() } },
    };
    const scope = createScope(ctx, agent);
    agent.ctx = scope.ctx;
    ctx.provide("agents");
    ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
    new Jobs(ctx, Jobs.Config({}));
    ctx.jobs.attachController("test");
    plugin.apply(scope.ctx);
    let failed;
    const failureEntered = new Promise((r) => (failed = r));
    ctx.jobs.wait = async () => {
      failed();
      throw Error("original wait failure");
    };
    const call = ctx.tools.execute({
      name: "execution_bus",
      callId: "call",
      arguments: {
        protocolVersion: 1,
        messageId: "m",
        requestId: "r",
        type: "request",
        payload: { handler: "test", input: { delayMs: 200, fail: false } },
      },
      agent,
      signal: new AbortController().signal,
    });
    await failureEntered;
    await delay(10);
    const disposal = scope.dispose();
    const result = await call;
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /original wait failure/);
    await disposal;
    assert.equal(ctx.jobs.list(agent.id).length, 0);
  },
);
