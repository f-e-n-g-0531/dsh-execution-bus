import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import LocalSubprocess from "@deepseek-ai/dsh-subprocess-local";
import NodePtcRuntime from "@deepseek-ai/dsh-ptc-runtime-node";
import { createScope } from "@deepseek-ai/dsh-scope";
import { derivePreset, PRESET_ID } from "../dist/preset.js";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { parsePlan } from "../dist/runtime/plan.js";

// Real host implementations and a real per-call Node PTC process. The explicit
// full-access policy is only a fixture policy, NOT an OS sandbox enforcement test.
async function fixture(mode = "ptc") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-ptc-"));
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  process.env.XIAOHE_RUNTIME_DIR = path.join(dir, "records");
  const root = new Context();
  let ctx;
  const events = [],
    executions = [],
    agents = new Map(),
    scopes = [];
  const host = root.plugin(function hostServices(context) {
    ctx = context;
    new SystemPrompt(ctx, {});
    new ToolRuntime(ctx, { mode });
    new SessionProjectionRegistry(ctx);
    ctx.provide("workingDirectory");
    ctx.set("workingDirectory", {
      defaultDirectory: dir,
      get: () => dir,
      ensure: async () => dir,
      set: async () => dir,
    });
    ctx.provide("agents");
    ctx.set("agents", { get: (id) => agents.get(id) });
    ctx.provide("sandboxPolicy");
    ctx.set("sandboxPolicy", {
      defaultMode: "danger-full-access",
      resolve: ({ session } = {}) => ({
        mode: "danger-full-access",
        workspaceRoot: dir,
        ...(session ? { sessionId: session.id } : {}),
      }),
    });
    new LocalFS(ctx, LocalFS.Config({ cwd: dir }));
    new LocalSubprocess(ctx);
    new NodePtcRuntime(
      ctx,
      NodePtcRuntime.Config({ timeoutMs: 10000, maxTimeoutMs: 15000 }),
    );
    new Jobs(ctx, Jobs.Config({}));
    new Loader(ctx, { baseUrl: pathToFileURL(process.cwd() + "/").href });
    new AgentPresetRegistry(
      ctx,
      AgentPresetRegistry.Config({ default: "ptc" }),
    );
    ctx.on("tools/pre-execute", async (exec, next) => {
      executions.push({
        name: exec.name,
        callId: exec.callId,
        rootCallId: exec.rootCallId,
        token: exec.token,
        parent: exec.parent,
        agent: exec.agent,
      });
      return next();
    });
  });
  await host.await();
  const cleanups = [];
  const close = async () => {
    try {
      for (const scope of scopes.reverse()) await scope.dispose();
      for (const dispose of cleanups.reverse()) await dispose();
      await host.dispose();
    } finally {
      if (previous === undefined) delete process.env.XIAOHE_RUNTIME_DIR;
      else process.env.XIAOHE_RUNTIME_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  try {
    const original = {
      id: "ptc",
      plugins: [
        { id: "files", name: "@deepseek-ai/dsh-tool-fs" },
        { id: "jobs", name: "@deepseek-ai/dsh-tool-jobs" },
      ],
    };
    cleanups.push(await ctx.agentPresets.register(original));
    const document = await ctx.agentPresets.readDocument("ptc");
    cleanups.push(
      await ctx.agentPresets.register(derivePreset(document.content)),
    );
    const agent = async (preset = PRESET_ID) => {
      const id = randomUUID();
      const owner = {
        id,
        session: {
          id,
          header: { cwd: dir },
          append: (type, data) => events.push({ owner: id, type, data }),
        },
      };
      const scope = createScope(ctx, owner);
      scopes.push(scope);
      owner.ctx = scope.ctx;
      agents.set(id, owner);
      await ctx.agentPresets.mount(scope.ctx, preset);
      return owner;
    };
    const owner = await agent();
    const call = (
      name,
      args,
      caller = owner,
      signal = new AbortController().signal,
    ) =>
      ctx.tools.execute({
        name,
        arguments: args,
        agent: caller,
        signal,
        callId: randomUUID(),
      });
    const program = async (code, caller = owner, options = {}) => {
      const result = await call(
        "run_code",
        {
          description: "Test declarative runtime host integration",
          code,
          ...options,
        },
        caller,
      );
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.value.result;
    };
    const runtime = async (name, input, caller = owner) => {
      if (mode === "ptc")
        return program(
          "return await tools." + name + "(" + JSON.stringify(input) + ");",
          caller,
        );
      const result = await call(name, input, caller);
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.value;
    };
    return {
      ctx,
      dir,
      owner,
      agent,
      call,
      program,
      runtime,
      events,
      executions,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const mode of ["native", "ptc"]) {
  test(
    mode +
      ": derived preset runs a real host filesystem DAG and retains typed results",
    { timeout: 20000 },
    async () => {
      const f = await fixture(mode);
      try {
        const plan = {
          concurrency: 2,
          steps: [
            {
              id: "a",
              tool: "write",
              input: { file_path: "a.txt", content: "alpha" },
            },
            {
              id: "b",
              tool: "write",
              input: { file_path: "b.txt", content: "beta" },
            },
            {
              id: "read",
              tool: "read",
              depends_on: ["a", "b"],
              input: { file_path: "a.txt" },
            },
            {
              id: "edit",
              tool: "edit",
              depends_on: ["read"],
              input: {
                file_path: "a.txt",
                old_string: "alpha",
                new_string: "changed",
              },
            },
          ],
        };
        const run = await f.runtime("runtime_run", { plan });
        assert.equal(run.state, "succeeded");
        assert.deepEqual(
          run.steps.map((step) => step.state),
          Array(4).fill("succeeded"),
        );
        assert.equal(
          readFileSync(path.join(f.dir, "a.txt"), "utf8"),
          "changed",
        );
        assert.equal(readFileSync(path.join(f.dir, "b.txt"), "utf8"), "beta");
        const result = await f.runtime("runtime_result", { runId: run.runId });
        assert.equal(result.finished, true);
        assert.equal(result.results.read.value.lines[0].text, "alpha");
        assert.equal(result.results.edit.value.after, "changed");
        const execution = f.executions.find(
          (entry) => entry.name === "runtime_run",
        );
        const nested = f.executions.filter((entry) =>
          ["write", "read", "edit"].includes(entry.name),
        );
        assert.equal(nested.length, 4);
        for (const entry of nested) {
          assert.equal(entry.parent, execution.token);
          assert.equal(entry.rootCallId, execution.rootCallId);
          assert.equal(entry.agent, f.owner);
        }
        if (mode === "ptc") {
          const outer = f.executions.find((entry) => entry.name === "run_code");
          assert.equal(execution.parent, outer.token);
          assert.equal(execution.rootCallId, outer.rootCallId);
          assert.ok(
            f.events.some(
              (event) =>
                event.type === "tool/ptc-dispatch" &&
                event.data.name === "runtime_run",
            ),
          );
          const pid = await f.program(
            'return (await import("node:process")).pid;',
          );
          assert.notEqual(
            pid,
            process.pid,
            "PTC must execute outside the test host process",
          );
          assert.notEqual(
            await f.program('return (await import("node:process")).pid;'),
            pid,
            "per-call PTC must start fresh processes",
          );
        } else {
          assert.equal(f.ctx.tools.get("run_code", f.owner), undefined);
        }
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "PTC transport hides native model-direct calls and original ptc never gains runtime tools",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const original = await f.agent("ptc");
      assert.equal(f.ctx.tools.get("runtime_run", original), undefined);
      assert.equal(
        await f.program("return typeof tools.runtime_run;", original),
        "undefined",
      );
      const direct = await f.call("runtime_run", {
        plan: {
          steps: [{ id: "a", tool: "read", input: { file_path: "missing" } }],
        },
      });
      assert.equal(direct.isError, true);
      assert.match(JSON.stringify(direct), /UNKNOWN_TOOL/);
      const invalid = await f.program(
        'try { await tools.runtime_run({ plan: { steps: [{ id: "a", tool: "run_code", input: {} }] } }); } catch (error) { return { name: error.name, tool: error.toolName, message: error.message }; }',
      );
      assert.equal(invalid.name, "ToolCallError");
      assert.equal(invalid.tool, "runtime_run");
      assert.match(invalid.message, /PLAN_UNKNOWN_TOOL/);
    } finally {
      await f.close();
    }
  },
);

test(
  "PTC nested host deny remains authoritative and dependent writes never execute",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const dispose = f.ctx.on("tools/pre-execute", async (exec, next) =>
        exec.name === "write"
          ? { kind: "deny", reason: "ptc-host-write-denied" }
          : next(),
      );
      try {
        const run = await f.runtime("runtime_run", {
          plan: {
            steps: [
              {
                id: "deny",
                tool: "write",
                input: { file_path: "denied.txt", content: "no" },
              },
              {
                id: "after",
                tool: "write",
                depends_on: ["deny"],
                input: { file_path: "after.txt", content: "no" },
              },
            ],
          },
        });
        assert.equal(run.state, "failed");
        assert.equal(run.steps[0].error, "RUNTIME_STEP_FAILED");
        assert.equal(run.steps[1].attempts, 0);
        assert.equal(existsSync(path.join(f.dir, "denied.txt")), false);
        assert.equal(existsSync(path.join(f.dir, "after.txt")), false);
        assert.equal(
          f.executions.filter((entry) => entry.name === "write").length,
          1,
        );
      } finally {
        dispose();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "PTC async runtime survives outer process completion and real host Job tools stay usable",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      writeFileSync(path.join(f.dir, "async.txt"), "async result");
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const stop = f.ctx.on("tools/execute", async (exec, next) => {
        if (exec.name === "read") await gate;
        return next();
      });
      let started;
      try {
        started = await f.runtime("runtime_run", {
          async: true,
          plan: {
            steps: [
              { id: "read", tool: "read", input: { file_path: "async.txt" } },
            ],
          },
        });
        assert.equal(started.state, "running");
        // The real outer PTC process has exited while the host read is still gated.
        assert.equal(
          (await f.runtime("runtime_status", { runId: started.runId })).state,
          "running",
        );
      } finally {
        release();
        stop();
      }
      let status;
      for (let i = 0; i < 20; i++) {
        status = await f.runtime("runtime_status", { runId: started.runId });
        if (status.state !== "running") break;
      }
      assert.equal(status.state, "succeeded");
      assert.equal(
        (await f.runtime("runtime_result", { runId: started.runId })).results
          .read.value.lines[0].text,
        "async result",
      );
      const jobs = await f.program("return await tools.job_list({});");
      assert.deepEqual(jobs, []);
      for (const name of ["job_output", "job_kill"]) {
        const error = await f.program(
          "try { await tools." +
            name +
            '({job_id: "not-a-job"}); return "unexpected"; } catch (error) { return { name: error.name, tool: error.toolName }; }',
        );
        assert.equal(error.name, "ToolCallError");
        assert.equal(error.tool, name);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  "PTC real host read failure retains retry counts and blocks dependent mutation",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const run = await f.runtime("runtime_run", {
        plan: {
          steps: [
            {
              id: "missing",
              tool: "read",
              retry: 1,
              input: { file_path: "missing.txt" },
            },
            {
              id: "write",
              tool: "write",
              depends_on: ["missing"],
              input: { file_path: "never.txt", content: "no" },
            },
          ],
        },
      });
      assert.equal(run.state, "failed");
      assert.equal(run.steps[0].attempts, 2);
      assert.equal(run.steps[0].error, "RUNTIME_STEP_FAILED");
      assert.equal(run.steps[1].attempts, 0);
      assert.equal(
        f.executions.filter((entry) => entry.name === "read").length,
        2,
      );
      assert.equal(existsSync(path.join(f.dir, "never.txt")), false);
    } finally {
      await f.close();
    }
  },
);

test(
  "PTC runtime owner boundary survives the program bridge",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      writeFileSync(path.join(f.dir, "owner.txt"), "private result");
      const run = await f.runtime("runtime_run", {
        plan: {
          steps: [
            { id: "read", tool: "read", input: { file_path: "owner.txt" } },
          ],
        },
      });
      const other = await f.agent();
      for (const name of [
        "runtime_status",
        "runtime_result",
        "runtime_cancel",
        "runtime_resume",
      ]) {
        const result = await f.program(
          "try { await tools." +
            name +
            "(" +
            JSON.stringify({ runId: run.runId }) +
            '); return "unexpected"; } catch (error) { return { name: error.name, tool: error.toolName, message: error.message }; }',
          other,
        );
        assert.equal(result.name, "ToolCallError");
        assert.equal(result.tool, name);
        assert.match(result.message, /RUNTIME_NOT_FOUND/);
        assert.doesNotMatch(JSON.stringify(result), /private result|owner.txt/);
      }
      assert.deepEqual((await f.runtime("runtime_status", {}, other)).runs, []);
      assert.equal(
        (await f.runtime("runtime_result", { runId: run.runId })).results.read
          .value.lines[0].text,
        "private result",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "PTC resume never replays an interrupted unknown write or an unrelated pending write",
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const store = new RunStore();
      const executor = new RuntimeExecutor(store, async () => {
        throw Error("seed must not execute");
      });
      const record = executor.createRun(
        f.owner.id,
        parsePlan({
          steps: [
            {
              id: "unknown",
              tool: "write",
              input: { file_path: "uncertain.txt", content: "never replay" },
            },
            {
              id: "pending",
              tool: "write",
              input: { file_path: "pending.txt", content: "never start" },
            },
          ],
        }),
      );
      record.state = "interrupted";
      record.finishedAt = record.updatedAt;
      record.steps[0].state = "unknown";
      record.steps[0].attempts = 1;
      record.steps[0].startedAt = record.createdAt;
      record.steps[0].finishedAt = record.updatedAt;
      record.steps[0].error = "RUNTIME_INTERRUPTED";
      store.save(record);
      const before = await f.runtime("runtime_status", { runId: record.runId });
      assert.equal(before.steps[0].state, "unknown");
      const after = await f.runtime("runtime_resume", { runId: record.runId });
      assert.equal(after.state, "failed");
      assert.equal(after.steps[0].error, "RUNTIME_INTERRUPTED");
      assert.equal(after.steps[0].attempts, 1);
      assert.equal(after.steps[1].attempts, 0);
      assert.equal(existsSync(path.join(f.dir, "uncertain.txt")), false);
      assert.equal(existsSync(path.join(f.dir, "pending.txt")), false);
      assert.equal(
        f.executions.some((entry) => entry.name === "write"),
        false,
      );
    } finally {
      await f.close();
    }
  },
);
