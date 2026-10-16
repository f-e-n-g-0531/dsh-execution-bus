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
import * as mode from "../dist/test-mode.js";
test(
  "real Node PTC run_code retains original file binding and adds bus binding",
  { timeout: 20000 },
  async () => {
    const ctx = new Context();
    new SystemPrompt(ctx, {});
    new ToolRuntime(ctx, {});
    new LocalFS(ctx, LocalFS.Config({ cwd: process.cwd() }));
    new Subprocess(ctx);
    ctx.provide("sandboxPolicy");
    ctx.set("sandboxPolicy", {
      defaultMode: "danger-full-access",
      resolve: () => ({
        mode: "danger-full-access",
        workspaceRoot: process.cwd(),
      }),
    });
    ctx.provide("sandbox");
    ctx.set("sandbox", {
      confine() {
        throw Error("fixture has no confinement backend");
      },
    });
    new NodePtc(ctx, NodePtc.Config({ timeoutMs: 5000, maxTimeoutMs: 10000 }));
    const agent = {
      id: "ptc-integration",
      session: { header: { cwd: process.cwd() }, append() {} },
    };
    const scope = createScope(ctx, agent);
    agent.ctx = scope.ctx;
    ctx.provide("agents");
    ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
    new Jobs(ctx, Jobs.Config({}));
    ctx.jobs.attachController("fixture");
    files.apply(scope.ctx, files.Config({}));
    scope.ctx.tools.presentAs("ptc");
    mode.apply(scope.ctx);
    const before = [];
    ctx.on("tools/pre-execute", async (exec, next) => {
      before.push(exec.name);
      return next();
    });
    try {
      const result = await ctx.tools.execute({
        name: "run_code",
        arguments: {
          code: 'const data = await tools.read({file_path:"package.json",limit:1}); const bus = await tools.execution_bus({protocolVersion:1,messageId:"m",requestId:"r",type:"request",payload:{handler:"test",input:{delayMs:10,fail:false}}}); const state=await tools.execution_bus_state({}); return {read:!!data,bus:bus.state,sessionTasks:state.counts.terminal};',
          description: "Verify PTC and bus bindings",
        },
        callId: "ptc",
        agent,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, false, JSON.stringify(result));
      assert.match(JSON.stringify(result), /succeeded/);
      assert.match(JSON.stringify(result), /sessionTasks/);
      assert.ok(before.includes("execution_bus_state"));
      assert.ok(before.includes("read") && before.includes("execution_bus"));
      assert.equal(ctx.tools.modeFor(agent), "ptc");
      assert.ok(ctx.tools.get("write", agent));
      const deny = ctx.on("tools/pre-execute", async (exec, next) =>
        exec.name === "write"
          ? { kind: "deny", reason: "ptc-host-denied" }
          : next(),
      );
      try {
        const denied = await ctx.tools.execute({
          name: "run_code",
          arguments: {
            code: 'return await tools.write({file_path:"never-write",content:"no"})',
            description: "Verify nested policy denial",
          },
          callId: "ptc-denied",
          agent,
          signal: new AbortController().signal,
        });
        assert.equal(denied.isError, true);
        assert.match(JSON.stringify(denied), /ptc-host-denied/);
      } finally {
        deny();
      }
    } finally {
      await scope.dispose();
    }
  },
);
