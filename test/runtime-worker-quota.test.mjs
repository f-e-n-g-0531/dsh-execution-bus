import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { NativeToolExecutor } from "@deepseek-ai/dsh-tool-executor-native";
import SandboxPolicy from "@deepseek-ai/dsh-sandbox-policy";
import Approval from "@deepseek-ai/dsh-user-approval";
import { WorkerQuota } from "../dist/runtime/worker-quota.js";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";

// Real host registry/loop fixture, kept local to this task's exclusive test file.
async function fixture(respond, preset = false) {
  const root = new Context();
  let ctx, loop, ready;
  const requests = [],
    events = [],
    bodies = [];
  const host = root.plugin(function hostServices(c) {
    ctx = c;
    new SessionProjectionRegistry(c);
    new SessionStore(c);
    new SystemPrompt(c, {});
    new ToolRuntime(c);
    c.provide("workingDirectory");
    c.set("workingDirectory", { get: () => process.cwd() });
    new Loader(c, { baseUrl: pathToFileURL(process.cwd() + "/").href });
    c.provide("ptcRuntime", {
      language: "typescript",
      async execute() {
        throw Error("PTC runtime must never execute for worker");
      },
    });
    c.provide("llm");
    c.set("llm", {
      async prepareCall(config, signal) {
        return {
          config,
          adapterDefaults: {},
          async *stream(request) {
            requests.push(request);
            const blocks = await respond(request, requests.length, signal);
            for (const [index, block] of blocks.entries()) {
              yield { type: "block-start", index, blockType: block.type };
              yield { type: "block-end", index, block };
            }
            yield {
              type: "finish",
              reason: {
                kind: blocks.some((b) => b.type === "tool-call")
                  ? "tool-calls"
                  : "stop",
              },
            };
          },
        };
      },
    });
    c.tools.setExecutor(new NativeToolExecutor(c));
    for (const name of [
      "read",
      "glob",
      "grep",
      "write",
      "pwsh",
      "runtime_run",
      "subagent",
    ]) {
      if (preset === "scoped" && ["read", "glob", "grep"].includes(name))
        continue;
      c.tools.register({
        name,
        description: name,
        parameters: {
          type: "object",
          properties: name === "read" ? { file_path: { type: "string" } } : {},
        },
        output: {
          schema: { type: "string" },
          render: (_a, value) => [{ type: "text", text: value }],
        },
        async execute(_args, exec) {
          bodies.push(name);
          return name + " result";
        },
      });
    }
    c.on("session/event", (session, event) => events.push({ session, event }));
  });
  await host.await();
  await root.plugin(AgentRegistry).await();
  await root
    .plugin(SandboxPolicy, {
      mode: "danger-full-access",
      workspaceRoot: process.cwd(),
    })
    .await();
  await root.plugin(Approval).await();
  const presets = root.plugin(AgentPresetRegistry, {
    default: "worker-parent",
  });
  await presets.await();
  loop = root.plugin(AgentLoop, { agents: [] });
  await loop.await();
  ready = root.inject(
    [
      "agents",
      "sandboxPolicy",
      "approval",
      "agentLoop",
      "tools",
      "systemPrompt",
      "workingDirectory",
      "agentPresets",
    ],
    (injected) => {
      ctx = injected;
    },
  );
  await ready.await();
  const unpreset = preset
    ? await ctx.agentPresets.register({
        id: "worker-parent",
        plugins: [
          { id: "ptc", name: "@deepseek-ai/dsh-tool-executor-ptc" },
          ...(preset === "scoped"
            ? [{ id: "fs", name: "./test/fixtures/worker-scoped-tools.mjs" }]
            : []),
        ],
      })
    : undefined;
  const parent = await ctx.agents.create({
    sessionId: "parent",
    agentOptions: { provider: "offline", model: "fixture" },
    meta: { cwd: process.cwd() },
    ...(preset
      ? {
          setup: async (childCtx) => {
            await ctx.agentPresets.mount(childCtx, "worker-parent");
          },
        }
      : {}),
  });
  const signal = new AbortController().signal;
  const toolSet = await ctx.tools.resolve({
    agent: parent.agent,
    modelSelection: parent.agent.model.current(),
    signal,
  });
  const exec = { agent: parent.agent, toolSet, signal };
  return {
    root,
    ctx,
    parent,
    exec,
    requests,
    events,
    bodies,
    async close() {
      toolSet.dispose();
      await parent.dispose();
      await ready.dispose();
      await loop.dispose();
      await unpreset?.();
      await presets.dispose();
      await host.dispose();
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.fail("lifecycle condition did not become true");
}
const plan = (count = 1) => ({
  plan: {
    concurrency: 4,
    steps: Array.from({ length: count }, (_, i) => ({
      id: "worker" + i,
      tool: "agent",
      input: { prompt: "inspect only" },
    })),
  },
});
async function services(t, respond) {
  const host = await fixture(respond);
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-worker-quota-"));
  const active = [];
  const create = (dir = root) => {
    // Controlled fixture has no parent-local policy; this is not an rc.1 host capability.
    const service = new RuntimeService(host.ctx, new RunStore(dir), {
      checkParentPolicy: () => ({ kind: "allow" }),
    });
    active.push(service);
    return service;
  };
  t.after(async () => {
    await Promise.all(active.map((service) => service.dispose()));
    await host.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { host, create, root };
}

test("quota admission is synchronous, bounded, and releases idempotently", () => {
  const quota = new WorkerQuota();
  const release = Array.from({ length: 8 }, () => quota.reserve());
  assert.equal(quota.activeCount, 8);
  assert.throws(() => quota.reserve(), {
    message: "RUNTIME_AGENT_CAPACITY_EXCEEDED",
  });
  assert.equal(quota.activeCount, 8);
  release[0]();
  release[0]();
  assert.equal(quota.activeCount, 7);
  const replacement = quota.reserve();
  for (const done of release) done();
  replacement();
  assert.equal(quota.activeCount, 0);
  for (const limit of [0, -1, NaN, Infinity, 1.5])
    assert.throws(() => new WorkerQuota(limit), RangeError);
});

test("same-root services share eight pending creations across concurrent runs; no queue", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await services(t, async () => [{ type: "text", text: "done" }]);
  const first = f.create(),
    second = f.create();
  const original = f.host.ctx.agents.create.bind(f.host.ctx.agents);
  let creates = 0;
  f.host.ctx.agents.create = async (options) => {
    creates++;
    await gate.promise;
    return original(options);
  };
  const a = first.run(plan(4), f.host.exec);
  const b = second.run(plan(4), f.host.exec);
  await until(() => creates === 8);
  assert.equal(first.capacity().workersInUse, 8);
  assert.equal(second.capacity().occupiedRuns, 2);
  assert.equal(second.capacity().executingRuns, 2);
  assert.equal(first.manager.workerQuota, second.manager.workerQuota);
  assert.equal(first.manager.workerQuota.activeCount, 8);
  const rejected = await second.run(plan(), f.host.exec);
  assert.equal(rejected.steps[0].error, "RUNTIME_AGENT_CAPACITY_EXCEEDED");
  assert.equal(creates, 8);
  gate.resolve();
  assert.equal((await a).state, "succeeded");
  assert.equal((await b).state, "succeeded");
  assert.equal(first.manager.workerQuota.activeCount, 0);
  await nextTurn();
  assert.equal(creates, 8, "rejected worker must not start later");
  assert.equal((await second.run(plan(), f.host.exec)).state, "succeeded");
});

test(
  "cancel during pending creation keeps quota until late handle disposal and never requests model",
  { timeout: 10000 },
  async (t) => {
    const gate = deferred(),
      entered = deferred(),
      cleaning = deferred(),
      cleaned = deferred();
    t.after(() => {
      gate.resolve();
      cleaned.resolve();
    });
    const f = await services(t, async () => [
      { type: "text", text: "must not run" },
    ]);
    const service = f.create();
    const original = f.host.ctx.agents.create.bind(f.host.ctx.agents);
    f.host.ctx.agents.create = async (options) => {
      // A host factory may finish creation before cancellation but return its handle late.
      const handle = await original(options);
      entered.resolve();
      await gate.promise;
      return {
        agent: handle.agent,
        async dispose() {
          await handle.dispose();
          cleaning.resolve();
          await cleaned.promise;
        },
      };
    };
    const controller = new AbortController();
    const done = service.run(plan(), {
      ...f.host.exec,
      signal: controller.signal,
    });
    await entered.promise;
    const runId = service.status({}, f.host.exec).runs[0].runId;
    const cancelled = service.cancel({ runId }, f.host.exec);
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelled.executionSettled, false);
    controller.abort();
    assert.equal(service.manager.workerQuota.activeCount, 1);
    const closing = service.dispose();
    gate.resolve();
    await cleaning.promise;
    assert.equal(service.manager.workerQuota.activeCount, 1);
    assert.equal(f.host.requests.length, 0);
    const successor = f.create();
    assert.equal(successor.capacity().occupiedRuns, 1);
    assert.equal(successor.capacity().executingRuns, 0);
    assert.equal(successor.capacity().cleanupRuns, 1);
    assert.equal(successor.capacity().workersInUse, 1);
    assert.equal(successor.manager.workerQuota, service.manager.workerQuota);
    assert.equal(
      successor.status({ runId }, f.host.exec).executionSettled,
      false,
    );
    cleaned.resolve();
    await closing;
    const drained = await done;
    assert.equal(drained.state, "cancelled");
    // Settled means this process drained scheduling and owned Worker cleanup,
    // not that an arbitrary ordinary tool has exited.
    assert.equal(drained.executionSettled, true);
    assert.equal(
      successor.status({ runId }, f.host.exec).executionSettled,
      true,
    );
    assert.equal(successor.manager.workerQuota.activeCount, 0);
    assert.equal(successor.capacity().occupiedRuns, 0);
    assert.equal(successor.capacity().cleanupRuns, 0);
    assert.equal(successor.capacity().workersInUse, 0);
  },
);

test("creation failures and invalid parent admission return reservations", async (t) => {
  const f = await services(t, async () => [{ type: "text", text: "done" }]);
  const service = f.create();
  const original = f.host.ctx.agents.create.bind(f.host.ctx.agents);
  f.host.ctx.agents.create = async () => {
    throw Error("fixture creation failure");
  };
  const failed = await service.run(plan(4), f.host.exec);
  assert.equal(failed.state, "failed");
  assert.equal(service.manager.workerQuota.activeCount, 0);
  f.host.ctx.agents.create = original;
  const invalid = await service.run(plan(), {
    ...f.host.exec,
    toolSet: undefined,
  });
  assert.equal(invalid.steps[0].error, "RUNTIME_AGENT_PARENT_REQUIRED");
  assert.equal(service.manager.workerQuota.activeCount, 0);
  assert.equal((await service.run(plan(), f.host.exec)).state, "succeeded");
});

test("aborted workers and service disposal hold quota until awaited cleanup finishes", async (t) => {
  const turn = deferred(),
    cleanup = deferred();
  t.after(() => {
    turn.resolve();
    cleanup.resolve();
  });
  const f = await services(t, async (_request, _index, signal) => {
    signal.addEventListener("abort", () => turn.resolve(), { once: true });
    await turn.promise;
    return [{ type: "text", text: "done" }];
  });
  const first = f.create(),
    second = f.create();
  const original = f.host.ctx.agents.create.bind(f.host.ctx.agents);
  let cleaning = 0;
  f.host.ctx.agents.create = async (options) => {
    const handle = await original(options);
    return {
      agent: handle.agent,
      async dispose() {
        cleaning++;
        await handle.dispose();
        await cleanup.promise;
      },
    };
  };
  const controller = new AbortController();
  const a = first.run(plan(4), { ...f.host.exec, signal: controller.signal });
  const b = second.run(plan(4), f.host.exec);
  await until(() => f.host.requests.length === 8);
  controller.abort();
  const disposal = first.dispose();
  turn.resolve();
  await until(() => cleaning === 8);
  assert.equal(first.manager.workerQuota.activeCount, 8);
  let disposed = false;
  void disposal.then(() => {
    disposed = true;
  });
  await nextTurn();
  assert.equal(disposed, false);
  const third = f.create();
  const rejected = await third.run(plan(), f.host.exec);
  assert.equal(rejected.steps[0].error, "RUNTIME_AGENT_CAPACITY_EXCEEDED");
  cleanup.resolve();
  await Promise.all([a, b, disposal]);
  assert.equal(first.manager.workerQuota.activeCount, 0);
  assert.equal((await third.run(plan(), f.host.exec)).state, "succeeded");
});

test(
  "real host timeout holds Worker quota and linked-run admission through cleanup",
  { timeout: 10000 },
  async (t) => {
    const entered = deferred(),
      cleaning = deferred(),
      cleanup = deferred();
    t.after(() => cleanup.resolve());
    const f = await services(t, async (_request, _index, signal) => {
      entered.resolve();
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      return [{ type: "text", text: "late" }];
    });
    const service = f.create(),
      observer = f.create();
    const original = f.host.ctx.agents.create.bind(f.host.ctx.agents);
    f.host.ctx.agents.create = async (options) => {
      const handle = await original(options);
      return {
        agent: handle.agent,
        async dispose() {
          await handle.dispose();
          cleaning.resolve();
          await cleanup.promise;
        },
      };
    };
    const request = plan();
    request.plan.task_id = "timeout_task";
    request.plan.steps[0].timeout_ms = 1000;
    let settled = false;
    const done = service.run(request, f.host.exec).then((run) => {
      settled = true;
      return run;
    });
    await entered.promise;
    await cleaning.promise;
    assert.equal(settled, false);
    assert.equal(service.manager.workerQuota.activeCount, 1);
    const id = observer.status({}, f.host.exec).runs[0].runId;
    await assert.rejects(
      observer.run(
        {
          plan: {
            task_id: "timeout_task",
            previous_run_id: id,
            steps: [{ id: "read", tool: "read", input: {} }],
          },
        },
        f.host.exec,
      ),
      /RUNTIME_TASK_LINK_INVALID/,
    );
    cleanup.resolve();
    const run = await done;
    assert.equal(run.state, "failed");
    assert.equal(run.steps[0].state, "unknown");
    assert.equal(run.steps[0].error, "RUNTIME_STEP_TIMEOUT");
    assert.equal(service.manager.workerQuota.activeCount, 0);
  },
);

test("cleanup rejection still releases the reservation after disposal settles", async (t) => {
  const f = await services(t, async () => [{ type: "text", text: "done" }]);
  const service = f.create();
  const original = f.host.ctx.agents.create.bind(f.host.ctx.agents);
  f.host.ctx.agents.create = async (options) => {
    const handle = await original(options);
    return {
      agent: handle.agent,
      async dispose() {
        await handle.dispose();
        throw Error("fixture cleanup rejection");
      },
    };
  };
  assert.equal((await service.run(plan(), f.host.exec)).state, "failed");
  assert.equal(service.manager.workerQuota.activeCount, 0);
  f.host.ctx.agents.create = original;
  assert.equal((await service.run(plan(), f.host.exec)).state, "succeeded");
});

test("different store roots have independent Worker budgets", async (t) => {
  const gate = deferred();
  t.after(() => gate.resolve());
  const f = await services(t, async () => {
    await gate.promise;
    return [{ type: "text", text: "done" }];
  });
  const first = f.create(),
    second = f.create(),
    other = f.create(path.join(f.root, "other"));
  const pending = [
    first.run(plan(4), f.host.exec),
    second.run(plan(4), f.host.exec),
  ];
  await until(() => f.host.requests.length === 8);
  pending.push(other.run(plan(), f.host.exec));
  await until(() => f.host.requests.length === 9);
  assert.notEqual(first.manager.workerQuota, other.manager.workerQuota);
  assert.equal(first.manager.workerQuota.activeCount, 8);
  assert.equal(other.manager.workerQuota.activeCount, 1);
  gate.resolve();
  assert.ok(
    (await Promise.all(pending)).every((run) => run.state === "succeeded"),
  );
});

test(
  "last service retains directory lock until owned Worker disposal finishes",
  { timeout: 10000 },
  async (t) => {
    const cleaning = deferred(),
      cleaned = deferred();
    t.after(() => cleaned.resolve());
    const f = await services(t, async () => [{ type: "text", text: "done" }]);
    const service = f.create();
    const original = f.host.ctx.agents.create.bind(f.host.ctx.agents);
    f.host.ctx.agents.create = async (options) => {
      const handle = await original(options);
      return {
        agent: handle.agent,
        async dispose() {
          await handle.dispose();
          cleaning.resolve();
          await cleaned.promise;
        },
      };
    };
    const done = service.run(plan(), f.host.exec);
    await cleaning.promise;
    const closing = service.dispose();
    const lock = path.join(f.root, ".runtime-owner.lock");
    assert.equal(existsSync(lock), true);
    const code = `import {acquireRootLock} from ${JSON.stringify(new URL("../dist/runtime/root-lock.js", import.meta.url).href)};
    try {const release=acquireRootLock(process.argv[1]);release();} catch(e) {console.error(e.message);process.exitCode=23;}`;
    const probe = () =>
      spawnSync(process.execPath, ["--input-type=module", "-e", code, f.root], {
        encoding: "utf8",
        timeout: 5000,
      });
    const denied = probe();
    assert.equal(denied.status, 23, denied.stderr);
    assert.equal(denied.stderr.trim(), "RUNTIME_ROOT_LOCKED");
    cleaned.resolve();
    await closing;
    await done;
    assert.equal(existsSync(lock), false);
    const allowed = probe();
    assert.equal(allowed.status, 0, allowed.stderr);
  },
);
