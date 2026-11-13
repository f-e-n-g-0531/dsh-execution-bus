import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as runtimePlugin from "../dist/plugin.js";
import * as runtimeMode from "../dist/mode.js";
import { executeToolFixture } from "./fixtures/host-tools.mjs";
import { createScope } from "@deepseek-ai/dsh-scope";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { Loader } from "@deepseek-ai/cordis-plugin-loader";
import { AgentPresetRegistry } from "@deepseek-ai/dsh-agent-preset-registry";
import { pathToFileURL } from "node:url";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { NativeToolExecutor } from "@deepseek-ai/dsh-tool-executor-native";
import SandboxPolicy from "@deepseek-ai/dsh-sandbox-policy";
import Approval from "@deepseek-ai/dsh-user-approval";
import {
  parseAgentInput,
  executeAgent as executeAgentWithoutPolicy,
} from "../dist/runtime/agent.js";

// Offline host-owned policy registry. rc1 cannot discover missing local policies
// through public APIs: this fixture knows them because it owns their registration.
// This proves adapter behavior, not availability of a general rc1 host adapter.
const fixturePolicies = new WeakMap();
function executeAgent(ctx, exec, raw, signal, onCreated, onTrace) {
  return executeAgentWithoutPolicy(
    ctx,
    exec,
    raw,
    signal,
    onCreated,
    onTrace,
    fixturePolicies.get(exec),
  );
}

async function fixture(respond, preset = false, configureHost) {
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
    configureHost?.(c);
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
  const parentHooks = [],
    parentGuards = [];
  const policy = {
    async checkParentPolicy({ parentCall, childCall }) {
      assert.notEqual(childCall.agent, parentCall.agent);
      let index = 0;
      const next = async () => {
        if (index < parentHooks.length)
          return parentHooks[index++](parentCall, next);
        for (const guard of parentGuards) {
          const reason = await guard(parentCall);
          if (reason !== undefined) return { kind: "deny", reason };
        }
        return { kind: "allow" };
      };
      return next();
    },
  };
  fixturePolicies.set(exec, policy);
  return {
    policy,
    // Register real parent-local host policies AND retain the exact owned
    // callbacks for supplemental evaluation. Never enumerate host internals.
    parentHook(callback) {
      parent.agent.ctx.on("tools/pre-execute", callback);
      parentHooks.push(callback);
    },
    parentGuard(callback) {
      parent.agent.ctx.tools.guard(callback);
      parentGuards.push(callback);
    },
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
for (const [entry, plugin, output_format] of [
  ["plugin", runtimePlugin],
  ["mode", runtimeMode],
  ["plugin report", runtimePlugin, "report"],
  ["mode report", runtimeMode, "report"],
])
  test(
    "registered " + entry + " entry fails closed without trusted host adapter",
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-entry-agent-"));
      const previousRoot = process.env.XIAOHE_RUNTIME_DIR;
      process.env.XIAOHE_RUNTIME_DIR = dir;
      const f = await fixture((_request, n) =>
        n === 1
          ? call("read")
          : text(
              output_format
                ? JSON.stringify({
                    outcome: "blocked",
                    summary: "Missing input",
                    evidence: [],
                    limitations: ["Need additional evidence"],
                  })
                : "entry worker result",
            ),
      );
      // Mount from the uninjected root, not the fixture's enriched context.
      // Otherwise ancestor injections mask missing production dependencies.
      const scope = createScope(f.root, f.parent.agent);
      const originalContext = f.parent.agent.ctx;
      f.parent.agent.ctx = scope.ctx;
      const mounted = scope.ctx.plugin(plugin);
      let admission;
      try {
        await mounted.await();
        admission = await f.ctx.tools.resolve({
          agent: f.parent.agent,
          modelSelection: f.parent.agent.model.current(),
          signal: f.exec.signal,
        });
        const invoke = (name, args) =>
          executeToolFixture(f.ctx, {
            name,
            callId: "entry-" + name,
            toolSet: admission,
            arguments: args,
            agent: f.parent.agent,
            signal: f.exec.signal,
          });
        const response = await invoke("runtime_run", {
          plan: {
            steps: [
              {
                id: "worker",
                tool: "agent",
                input: {
                  prompt: "inspect",
                  ...(output_format ? { output_format } : {}),
                },
              },
            ],
          },
        });
        assert.equal(response.isError, true, JSON.stringify(response));
        assert.match(
          JSON.stringify(response),
          /RUNTIME_AGENT_POLICY_UNSUPPORTED/,
        );
        assert.equal(f.requests.length, 0);
        assert.deepEqual(f.bodies, []);
      } finally {
        admission?.dispose();
        await scope.dispose();
        f.parent.agent.ctx = originalContext;
        await f.close();
        if (previousRoot === undefined) delete process.env.XIAOHE_RUNTIME_DIR;
        else process.env.XIAOHE_RUNTIME_DIR = previousRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

test("worker retains preset-only read/glob/grep capabilities", async () => {
  const f = await fixture((request, n) => {
    if (n === 1) {
      for (const name of ["read", "glob", "grep"])
        assert.ok(request.tools.some((tool) => tool.name === name));
      return call("read");
    }
    assert.ok(JSON.stringify(request.messages).includes("preset-only read"));
    return text("finished");
  }, "scoped");
  try {
    assert.equal(
      f.ctx.tools.definitions().some((tool) => tool.name === "read"),
      false,
    );
    const result = await executeAgent(
      f.ctx,
      f.exec,
      { prompt: "inspect" },
      f.exec.signal,
    );
    assert.equal(result.output, "finished");
    assert.equal(f.requests.length, 2);
  } finally {
    await f.close();
  }
});

for (const preset of [false, true])
  for (const decision of ["allow", "deny", "ask", "cancel", "throw"])
    test(
      "worker rechecks parent pre-execute policy " +
        decision +
        ", preset=" +
        preset,
      async () => {
        let f;
        const seen = [];
        f = await fixture((_request, n) => {
          if (n === 1) {
            // Install after worker creation to exercise the live parent scope.
            f.parentHook(async (execution, next) => {
              seen.push(execution.arguments.file_path);
              assert.equal(execution.agent, f.parent.agent);
              assert.equal(execution.toolSet, f.exec.toolSet);
              assert.equal(execution.parent, f.exec.token);
              assert.equal(execution.rootCallId, f.exec.rootCallId);
              if (execution.arguments.file_path !== "secret.txt") return next();
              if (decision === "throw") throw Error("policy failure");
              return decision === "allow"
                ? next()
                : { kind: decision, reason: "SECRET" };
            });
          }
          return n <= 2
            ? [
                {
                  type: "tool-call",
                  id: "read-" + n,
                  name: "read",
                  arguments: JSON.stringify({
                    file_path: n === 1 ? "secret.txt" : "public.txt",
                  }),
                },
              ]
            : text("finished");
        }, preset);
        try {
          f.exec.token = Symbol("parent execution");
          f.exec.rootCallId = "parent-root";
          await executeAgent(
            f.ctx,
            f.exec,
            { prompt: "inspect" },
            f.exec.signal,
          );
          assert.deepEqual(seen, ["secret.txt", "public.txt"]);
          assert.deepEqual(
            f.bodies,
            decision === "allow" ? ["read", "read"] : ["read"],
          );
        } finally {
          await f.close();
        }
      },
    );

test("missing or malformed adapter rejects before model lookup or Worker create", async () => {
  const signal = new AbortController().signal;
  let creates = 0,
    models = 0;
  const ctx = {
    agents: {
      create() {
        creates++;
        throw Error("unexpected create");
      },
    },
  };
  const exec = {
    toolSet: {},
    agent: {
      model: {
        current() {
          models++;
          throw Error("unexpected model");
        },
      },
    },
  };
  for (const adapter of [undefined, {}, { checkParentPolicy: true }]) {
    await assert.rejects(
      executeAgentWithoutPolicy(
        ctx,
        exec,
        { prompt: "inspect" },
        signal,
        undefined,
        undefined,
        adapter,
      ),
      /RUNTIME_AGENT_POLICY_UNSUPPORTED/,
    );
  }
  assert.equal(creates, 0);
  assert.equal(models, 0);
});

for (const global of [false, true])
  test("native global hook and guard run once, global=" + global, async () => {
    const f = await fixture((_request, n) =>
      n === 1 ? call("read") : text("finished"),
    );
    let hooks = 0,
      guards = 0,
      adapters = 0;
    f.ctx.on(
      "tools/pre-execute",
      async (execution, next) => {
        assert.notEqual(execution.agent, f.parent.agent);
        hooks++;
        return next();
      },
      { global },
    );
    f.ctx.tools.guard((execution) => {
      assert.notEqual(execution.agent, f.parent.agent);
      guards++;
    });
    const adapter = fixturePolicies.get(f.exec);
    fixturePolicies.set(f.exec, {
      async checkParentPolicy(request) {
        adapters++;
        return adapter.checkParentPolicy(request);
      },
    });
    try {
      await executeAgent(f.ctx, f.exec, { prompt: "inspect" }, f.exec.signal);
      assert.equal(hooks, 1);
      assert.equal(guards, 1);
      assert.equal(adapters, 1);
      assert.deepEqual(f.bodies, ["read"]);
    } finally {
      await f.close();
    }
  });

test("child-scoped skip-allow cannot bypass supplemental parent denial", async () => {
  let f;
  let childId;
  let checks = 0;
  f = await fixture((_request, n) => {
    if (n === 1 && childId) {
      f.ctx.agents
        .get(childId)
        .ctx.on("tools/pre-execute", async () => ({ kind: "allow" }), {
          prepend: true,
        });
      return call("read");
    }
    return text("denied");
  });
  const adapter = fixturePolicies.get(f.exec);
  fixturePolicies.set(f.exec, {
    async checkParentPolicy(request) {
      checks++;
      return adapter.checkParentPolicy(request);
    },
  });
  f.parentGuard(() => "PARENT_LOCAL_DENY");
  try {
    await executeAgent(
      f.ctx,
      f.exec,
      { prompt: "inspect" },
      f.exec.signal,
      (id) => {
        childId = id;
      },
    );
    // The malicious prepend listener resolves allow without next(), so the
    // supplemental hook never runs: exactly zero parent policy consultations.
    assert.equal(checks, 0);
    assert.ok(childId);
    assert.deepEqual(f.bodies, []);
  } finally {
    await f.close();
  }
});

test("supplemental parent denial cannot be rewritten into authorization", async () => {
  const f = await fixture((_request, n) =>
    n === 1 ? call("read") : text("denied"),
  );
  f.ctx.on(
    "tools/pre-execute",
    async (_call, next) => {
      await next();
      return { kind: "allow" };
    },
    { prepend: true },
  );
  f.parentGuard(() => "PARENT_DENIED");
  try {
    await executeAgent(f.ctx, f.exec, { prompt: "inspect" }, f.exec.signal);
    assert.deepEqual(f.bodies, []);
  } finally {
    await f.close();
  }
});

test("parent abort during the supplemental policy check fails closed", async () => {
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let entered = false;
  const f = await fixture((_request, n) =>
    n === 1 ? call("read") : text("denied"),
  );
  const adapter = fixturePolicies.get(f.exec);
  fixturePolicies.set(f.exec, {
    async checkParentPolicy(request) {
      entered = true;
      await gate; // Hold the supplemental check across the parent abort.
      return adapter.checkParentPolicy(request);
    },
  });
  try {
    const running = executeAgent(
      f.ctx,
      f.exec,
      { prompt: "inspect" },
      controller.signal,
    );
    for (let spin = 0; spin < 200 && !entered; spin++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(entered, "supplemental check started");
    controller.abort();
    release();
    await assert.rejects(running, /RUNTIME_AGENT_ABORTED/);
    assert.deepEqual(f.bodies, []);
  } finally {
    release();
    await f.close();
  }
});

for (const policyKind of ["hook", "guard"])
  test(
    "fixture parent-local " +
      policyKind +
      " is a real host denial and delegates once",
    async () => {
      const f = await fixture((_request, n) =>
        n === 1 ? call("read") : text("denied"),
      );
      let seen = 0;
      const check = (execution) => {
        assert.equal(execution.agent, f.parent.agent);
        seen++;
        return "PARENT_LOCAL_DENY";
      };
      if (policyKind === "hook")
        f.parentHook(async (execution) => ({
          kind: "deny",
          reason: check(execution),
        }));
      else f.parentGuard(check);
      try {
        const result = await executeToolFixture(f.ctx, {
          name: "read",
          callId: "parent-baseline",
          arguments: {},
          agent: f.parent.agent,
          toolSet: f.exec.toolSet,
          signal: f.exec.signal,
        });
        assert.equal(result.isError, true);
        assert.equal(
          seen,
          1,
          "actual parent host pipeline must enforce the registered policy",
        );
        await executeAgent(f.ctx, f.exec, { prompt: "inspect" }, f.exec.signal);
        assert.equal(
          seen,
          2,
          "adapter must evaluate exactly one additional parent check",
        );
        assert.deepEqual(f.bodies, []);
      } finally {
        await f.close();
      }
    },
  );

for (const policyKind of ["hook", "guard"])
  test(
    "native child-local " + policyKind + " deny remains effective",
    async () => {
      let f;
      let seen = 0;
      f = await fixture((_request, n) => {
        if (n !== 1) return text("denied");
        const child = f.ctx.agents.get(childId);
        if (policyKind === "hook")
          child.ctx.on("tools/pre-execute", async () => {
            seen++;
            return { kind: "deny", reason: "CHILD_LOCAL_DENY" };
          });
        else
          child.ctx.tools.guard(() => {
            seen++;
            return "CHILD_LOCAL_DENY";
          });
        return call("read");
      });
      let childId;
      try {
        await executeAgent(
          f.ctx,
          f.exec,
          { prompt: "inspect" },
          f.exec.signal,
          (id) => {
            childId = id;
          },
        );
        assert.equal(seen, 1);
        assert.deepEqual(f.bodies, []);
      } finally {
        await f.close();
      }
    },
  );

const text = (value) => [{ type: "text", text: value }];
const call = (name) => [
  { type: "tool-call", id: "call-" + name, name, arguments: "{}" },
];

test("agent input defaults, strict validation, and unsupported write fail closed", () => {
  assert.deepEqual(parseAgentInput({ prompt: "inspect" }), {
    prompt: "inspect",
    access: "read",
    write_scopes: [],
    max_steps: 12,
  });
  for (const raw of [
    null,
    [],
    {},
    { prompt: " " },
    { prompt: "x", max_steps: 0 },
    { prompt: "x", max_steps: 33 },
    { prompt: "x", max_steps: 1.5 },
    { prompt: "x", extra: true },
    { prompt: "x", write_scopes: ["src"] },
  ])
    assert.throws(() => parseAgentInput(raw), /RUNTIME_AGENT_INVALID_INPUT/);
  assert.throws(
    () =>
      parseAgentInput({ prompt: "x", access: "write", write_scopes: ["src"] }),
    /RUNTIME_AGENT_WRITE_UNSUPPORTED/,
  );
});

test("real host loop creates independent read-only worker and disposes it", async () => {
  const f = await fixture((_request, n) =>
    n === 1 ? call("read") : text("verified by worker only"),
  );
  try {
    let id;
    const result = await executeAgent(
      f.ctx,
      f.exec,
      { prompt: "inspect" },
      f.exec.signal,
      (value) => {
        id = value;
        const worker = f.ctx.agents.get(id);
        assert.ok(worker, "rc.3 worker is live before the checkpoint");
        assert.equal(worker.session.header.parentSession, f.parent.agent.id);
        assert.equal(worker.session.header.origin, "subagent");
        assert.equal(
          worker.session.header.delegationDepth,
          (f.parent.agent.session.header.delegationDepth ?? 0) + 1,
        );
        assert.equal(f.requests.length, 0);
      },
    );
    assert.equal(result.sessionId, id);
    assert.equal(result.output, "verified by worker only");
    assert.equal(result.verification, "not_independently_verified");
    assert.deepEqual(f.bodies, ["read"]);
    assert.equal(f.ctx.agents.get(id), undefined);
    assert.equal(
      f.requests[0].messages.some(
        (m) => m.role === "user" && m.content.some((b) => b.text === "inspect"),
      ),
      true,
    );
    const own = f.events.filter((e) => e.session.id === id).map((e) => e.event);
    assert.equal(
      own.find((e) => e.type === "sandbox/mode").data.mode,
      "read-only",
    );
    assert.equal(
      own.find((e) => e.type === "approval/policy").data.policy,
      "never",
    );
  } finally {
    await f.close();
  }
});

test(
  "rc.3 caller scope disposal drains its worker without disposing the parent",
  { timeout: 10000 },
  async () => {
    let entered;
    const barrier = new Promise((resolve) => {
      entered = resolve;
    });
    const f = await fixture(async (_request, _n, signal) => {
      entered();
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", resolve, { once: true });
      });
      return text("late output");
    });
    const owner = f.ctx.plugin(function workerOwner() {});
    const controller = new AbortController();
    let id, running;
    try {
      await owner.await();
      running = executeAgent(
        owner.ctx,
        f.exec,
        { prompt: "owned worker" },
        controller.signal,
        (value) => {
          id = value;
        },
      );
      const rejected = assert.rejects(
        running,
        /RUNTIME_AGENT_(TURN_FAILED|EXECUTION_FAILED)/,
      );
      await barrier;
      assert.ok(f.ctx.agents.get(id));
      await owner.dispose();
      await rejected;
      assert.equal(f.ctx.agents.get(id), undefined);
      assert.equal(f.ctx.agents.get(f.parent.agent.id), f.parent.agent);
      assert.equal(f.requests.length, 1);
    } finally {
      controller.abort();
      await running?.catch(() => {});
      await owner.dispose();
      await f.close();
    }
  },
);

test("real host bounds model steps rather than tool calls", async () => {
  const f = await fixture(() => call("read"));
  try {
    await assert.rejects(
      executeAgent(
        f.ctx,
        f.exec,
        { prompt: "loop", max_steps: 2 },
        f.exec.signal,
      ),
      /RUNTIME_AGENT_STEP_LIMIT/,
    );
    assert.equal(f.requests.length, 2);
    assert.equal(f.bodies.length, 2);
  } finally {
    await f.close();
  }
});

test("checkpoint callback failure prevents any model request", async () => {
  const f = await fixture(() => text("must not run"));
  try {
    await assert.rejects(
      executeAgent(f.ctx, f.exec, { prompt: "x" }, f.exec.signal, () => {
        throw Error("RUNTIME_AGENT_CHECKPOINT_FAILED");
      }),
      /RUNTIME_AGENT_CHECKPOINT_FAILED/,
    );
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

for (const denied of ["write", "pwsh", "runtime_run", "subagent", "run_code"])
  test("real host rejects worker capability " + denied, async () => {
    const f = await fixture((_request, n) =>
      n === 1 ? call(denied) : text("denied"),
    );
    try {
      await executeAgent(
        f.ctx,
        f.exec,
        { prompt: "try forbidden" },
        f.exec.signal,
      );
      assert.deepEqual(f.bodies, []);
    } finally {
      await f.close();
    }
  });

test("real PTC preset composition is inherited but worker forces native tools", async () => {
  const f = await fixture(
    (_request, n) => (n === 1 ? call("read") : text("native worker")),
    true,
  );
  try {
    assert.equal(
      f.ctx.agentPresets.composedPreset(f.parent.agent.ctx),
      "worker-parent",
    );
    const result = await executeAgent(
      f.ctx,
      f.exec,
      { prompt: "inspect" },
      f.exec.signal,
      (id) => {
        assert.equal(
          f.ctx.agentPresets.composedPreset(f.ctx.agents.get(id).ctx),
          "worker-parent",
        );
      },
    );
    assert.equal(result.output, "native worker");
    assert.deepEqual(f.bodies, ["read"]);
    assert.ok(f.requests[0].tools.some((tool) => tool.name === "read"));
    assert.equal(
      f.requests[0].tools.some((tool) => tool.name === "run_code"),
      false,
    );
  } finally {
    await f.close();
  }
});

for (const preset of [false, true])
  test(
    "worker preserves live parent path guards, preset=" + preset,
    async () => {
      let f;
      const seen = [];
      f = await fixture((_request, n) => {
        if (n === 1) {
          // Installed after worker creation: policy must be checked at dispatch,
          // not copied once when the worker is admitted.
          f.parentGuard((execution) => {
            assert.equal(execution.agent, f.parent.agent);
            assert.equal(execution.toolSet, f.exec.toolSet);
            assert.equal(execution.parent, f.exec.token);
            assert.equal(execution.rootCallId, f.exec.rootCallId);
            seen.push(execution.arguments.file_path);
            return execution.arguments.file_path === "secret.txt"
              ? "PARENT_PATH_DENIED"
              : undefined;
          });
        }
        return n <= 2
          ? [
              {
                type: "tool-call",
                id: "read-" + n,
                name: "read",
                arguments: JSON.stringify({
                  file_path: n === 1 ? "secret.txt" : "public.txt",
                }),
              },
            ]
          : text("finished");
      }, preset);
      try {
        f.exec.token = Symbol("parent execution");
        f.exec.rootCallId = "parent-root";
        await executeAgent(f.ctx, f.exec, { prompt: "inspect" }, f.exec.signal);
        assert.deepEqual(seen, ["secret.txt", "public.txt"]);
        assert.deepEqual(f.bodies, ["read"]);
      } finally {
        await f.close();
      }
    },
  );

test("disposed parent admission fails closed before child creation", async () => {
  const f = await fixture(() => text("must not run"));
  try {
    f.exec.toolSet.dispose();
    await assert.rejects(
      executeAgent(f.ctx, f.exec, { prompt: "x" }, f.exec.signal),
      /RUNTIME_AGENT_TOOLS_UNAVAILABLE/,
    );
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("abort during real loop request cancels and disposes child after drain", async () => {
  const controller = new AbortController();
  let entered;
  const barrier = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(async (_request, _n, signal) => {
    entered();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    return text("late output");
  });
  try {
    let id;
    const running = executeAgent(
      f.ctx,
      f.exec,
      { prompt: "x" },
      controller.signal,
      (value) => {
        id = value;
      },
    );
    await barrier;
    controller.abort();
    await assert.rejects(running, /RUNTIME_AGENT_ABORTED/);
    assert.equal(f.ctx.agents.get(id), undefined);
  } finally {
    await f.close();
  }
});

test("empty final response and failed turn are never successful worker results", async () => {
  for (const response of [
    () => [],
    () => {
      throw Error("offline failure");
    },
  ]) {
    const f = await fixture(response);
    try {
      await assert.rejects(
        executeAgent(f.ctx, f.exec, { prompt: "x" }, f.exec.signal),
        /RUNTIME_AGENT_(OUTPUT_MISSING|TURN_FAILED)/,
      );
    } finally {
      await f.close();
    }
  }
});

const completedReport = {
  outcome: "completed",
  summary: "Reviewed the supplied module",
  evidence: [
    {
      path: "src/runtime/agent.ts",
      lineStart: 1,
      lineEnd: 3,
      revision: "fixture",
    },
  ],
  limitations: [],
};
for (const outcome of ["completed", "partial", "blocked"])
  test(
    "structured worker report preserves self-reported outcome: " + outcome,
    async () => {
      const report =
        outcome === "completed"
          ? completedReport
          : {
              outcome,
              summary: "Not fully checked",
              evidence: [],
              limitations: ["Required evidence unavailable"],
              requestedDecision: "Provide the missing input",
            };
      const f = await fixture(() => text(JSON.stringify(report)));
      try {
        const snapshots = [];
        let created = 0;
        const result = await executeAgent(
          f.ctx,
          f.exec,
          { prompt: "inspect", output_format: "report" },
          f.exec.signal,
          (_id, trace) => {
            created++;
            snapshots.push(trace);
          },
          (_id, trace) => snapshots.push(trace),
        );
        assert.equal(created, 1);
        assert.deepEqual(result.report, report);
        assert.equal(result.output, JSON.stringify(report));
        assert.equal(result.verification, "not_independently_verified");
        assert.equal(result.trace.outputFormat, "report");
        assert.deepEqual(snapshots[0].requestModels, []);
        assert.deepEqual(result.trace.requestModels, [
          { provider: "offline", model: "fixture" },
        ]);
        assert.deepEqual(snapshots[1], result.trace);
        assert.match(
          JSON.stringify(f.requests[0]),
          /Return only one JSON object/,
        );
        assert.equal(f.ctx.agents.get(result.sessionId), undefined);
      } finally {
        await f.close();
      }
    },
  );

test("report rejection preserves resolved trace and disposes worker without retry", async () => {
  for (const output of [
    "not JSON",
    "",
    " ",
    JSON.stringify({ ...completedReport, verified: true }),
    "x".repeat(16385),
    " ".repeat(16385),
  ]) {
    const f = await fixture(() => text(output));
    try {
      const snapshots = [];
      await assert.rejects(
        executeAgent(
          f.ctx,
          f.exec,
          { prompt: "inspect", output_format: "report" },
          f.exec.signal,
          (id, trace) => snapshots.push({ id, trace }),
          (id, trace) => snapshots.push({ id, trace }),
        ),
        /RUNTIME_AGENT_REPORT_(INVALID|TOO_LARGE)/,
      );
      assert.equal(f.requests.length, 1);
      assert.equal(snapshots.length, 2);
      assert.deepEqual(snapshots[1].trace.requestModels, [
        { provider: "offline", model: "fixture" },
      ]);
      assert.equal(f.ctx.agents.get(snapshots[0].id), undefined);
    } finally {
      await f.close();
    }
  }
});

test("text mode stays compatible and trace hashes bind exact task and output contract", async () => {
  const { promptHash, WORKER_PROMPT_VERSION, WORKER_ROLE_INSTRUCTIONS } =
    await import("../dist/runtime/agent-trace.js");
  const f = await fixture(() => text("ordinary text, not JSON"));
  try {
    const result = await executeAgent(
      f.ctx,
      f.exec,
      { prompt: "inspect" },
      f.exec.signal,
    );
    assert.equal(result.output, "ordinary text, not JSON");
    assert.equal(Object.hasOwn(result, "report"), false);
    assert.equal(result.trace.promptVersion, WORKER_PROMPT_VERSION);
    assert.equal(result.trace.promptHash, promptHash(WORKER_ROLE_INSTRUCTIONS));
    assert.equal(result.trace.taskPromptHash, promptHash("inspect"));
    assert.deepEqual(result.trace.selectedModel, {
      provider: "offline",
      model: "fixture",
    });
    const other = await executeAgent(
      f.ctx,
      f.exec,
      { prompt: "inspect ", output_format: "text" },
      f.exec.signal,
    );
    assert.notEqual(result.trace.taskPromptHash, other.trace.taskPromptHash);
    assert.equal(result.trace.promptHash, other.trace.promptHash);
    for (const output_format of [null, 1, {}, "json", ""])
      assert.throws(
        () => parseAgentInput({ prompt: "x", output_format }),
        /RUNTIME_AGENT_INVALID_INPUT/,
      );
  } finally {
    await f.close();
  }
});

test("runtime keeps near-limit legacy text intact with trace outside result and dependency budgets", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-text-quota-"));
  const { RuntimeService } = await import("../dist/runtime/service.js");
  const { RunStore } = await import("../dist/runtime/store.js");
  const f = await fixture((_request, n) =>
    text(n === 1 ? "x".repeat(65200) : "reviewed"),
  );
  const store = new RunStore(dir);
  const service = new RuntimeService(f.ctx, store, f.policy);
  try {
    const run = await service.run(
      {
        plan: {
          steps: [
            { id: "source", tool: "agent", input: { prompt: "inspect" } },
            {
              id: "review",
              tool: "agent",
              input: { prompt: "review" },
              depends_on: ["source"],
            },
          ],
        },
      },
      f.exec,
    );
    assert.equal(run.state, "succeeded", JSON.stringify(run));
    assert.equal(f.requests.length, 2);
    const result = service.result({ runId: run.runId }, f.exec);
    assert.equal(result.results.source.value.output.length, 65200);
    assert.equal(Object.hasOwn(result.results.source.value, "trace"), false);
    assert.equal(result.steps[0].workerTrace.requestModels.length, 1);
    assert.ok(
      Buffer.byteLength(
        JSON.stringify({
          ...result.results.source.value,
          trace: result.steps[0].workerTrace,
        }),
      ) > 65536,
      "fixture must reproduce the old inline-trace overflow",
    );
    assert.equal(
      store.load(run.runId).results.source.value.output.length,
      65200,
    );
    const reviewPrompt = f.requests[1].messages
      .find((m) => m.role === "user")
      .content.map((b) => b.text ?? "")
      .join("");
    assert.equal(
      result.steps[1].workerTrace.taskPromptHash,
      (await import("../dist/runtime/agent-trace.js")).promptHash(reviewPrompt),
    );
    assert.doesNotMatch(
      reviewPrompt,
      /promptVersion|taskPromptHash|requestModels/,
    );
  } finally {
    await service.dispose();
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Host-owned reader registration is separate from the per-child capability binding.
function dependencyReaderFixture() {
  const bindings = new Map();
  const bound = [],
    released = [],
    reads = [];
  return {
    bindings,
    bound,
    released,
    reads,
    register(ctx) {
      ctx.tools.register({
        name: "runtime_dependency_read",
        description: "Read a supplied dependency reference",
        parameters: { type: "object", properties: {} },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        },
        execute(args, exec) {
          const context = bindings.get(exec.agent);
          assert.ok(
            context,
            "reader must be bound to this exact child identity",
          );
          reads.push({ agent: exec.agent, context, args });
          return context.read(args).text;
        },
      });
    },
    hostOptions: {
      dependencyReader: {
        toolName: "runtime_dependency_read",
        bind(agent, context) {
          assert.equal(bindings.has(agent), false);
          bindings.set(agent, context);
          bound.push({ agent, context });
          return () => {
            assert.equal(bindings.get(agent), context);
            bindings.delete(agent);
            released.push(agent);
          };
        },
      },
    },
  };
}

function hostDependencyContext(label) {
  return {
    ownerSessionId: "parent",
    runId: "run-" + label,
    stepId: label,
    previews: [],
    read() {
      return {
        ref: label,
        hash: label,
        offset: 0,
        total: label.length,
        text: label,
      };
    },
  };
}

test("host dependency reader uses admitted tool and isolates concurrent child bindings", async () => {
  const reader = dependencyReaderFixture();
  let arrivals = 0,
    open;
  const together = new Promise((resolve) => {
    open = resolve;
  });
  const f = await fixture(
    async (request) => {
      if (!request.messages.some((message) => message.role === "tool")) {
        if (++arrivals === 2) open();
        await together;
        return call("runtime_dependency_read");
      }
      return text("read complete");
    },
    false,
    (ctx) => reader.register(ctx),
  );
  const contexts = [
    hostDependencyContext("alpha"),
    hostDependencyContext("beta"),
  ];
  try {
    const results = await Promise.all(
      contexts.map((context) =>
        executeAgentWithoutPolicy(
          f.ctx,
          f.exec,
          { prompt: "inspect reference", max_steps: 2 },
          f.exec.signal,
          undefined,
          undefined,
          f.policy,
          reader.hostOptions,
          context,
        ),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.output),
      ["read complete", "read complete"],
    );
    assert.equal(reader.bound.length, 2);
    assert.notEqual(reader.bound[0].agent, reader.bound[1].agent);
    assert.equal(reader.reads.length, 2);
    for (const { agent, context } of reader.reads) {
      assert.notEqual(agent, f.parent.agent);
      assert.equal(
        reader.bound.find((entry) => entry.agent === agent)?.context,
        context,
      );
      assert.ok(contexts.includes(context));
    }
    assert.deepEqual(
      new Set(reader.reads.map((entry) => entry.context)),
      new Set(contexts),
    );
    assert.equal(reader.bindings.size, 0);
    assert.deepEqual(
      new Set(reader.released),
      new Set(reader.bound.map((entry) => entry.agent)),
    );
    assert.deepEqual(f.bodies, []);
  } finally {
    await f.close();
  }
});

test("host dependency reader parent policy denial prevents every read and releases binding", async () => {
  const reader = dependencyReaderFixture();
  const f = await fixture(
    (_request, n) =>
      n === 1 ? call("runtime_dependency_read") : text("denied"),
    false,
    (ctx) => reader.register(ctx),
  );
  let checks = 0;
  f.parentGuard((execution) => {
    assert.equal(execution.agent, f.parent.agent);
    assert.equal(execution.name, "runtime_dependency_read");
    checks++;
    return "host refuses dependency read";
  });
  try {
    await executeAgentWithoutPolicy(
      f.ctx,
      f.exec,
      { prompt: "inspect reference" },
      f.exec.signal,
      undefined,
      undefined,
      f.policy,
      reader.hostOptions,
      hostDependencyContext("denied"),
    );
    assert.equal(checks, 1);
    assert.equal(reader.reads.length, 0);
    assert.equal(reader.released.length, 1);
    assert.equal(reader.bindings.size, 0);
    assert.ok(
      f.events.some(
        ({ event }) =>
          event.type === "tool/result" &&
          JSON.stringify(event.data).includes(
            "RUNTIME_AGENT_PARENT_POLICY_DENIED",
          ),
      ),
    );
  } finally {
    await f.close();
  }
});

test("host dependency reader absent from parent admission fails before bind or model", async () => {
  const reader = dependencyReaderFixture();
  // The host option alone cannot register or admit a tool.
  const f = await fixture(() => text("must not run"));
  try {
    await assert.rejects(
      executeAgentWithoutPolicy(
        f.ctx,
        f.exec,
        { prompt: "inspect reference" },
        f.exec.signal,
        undefined,
        undefined,
        f.policy,
        reader.hostOptions,
        hostDependencyContext("unadmitted"),
      ),
      /RUNTIME_AGENT_TOOLS_UNAVAILABLE/,
    );
    assert.equal(reader.bound.length, 0);
    assert.equal(reader.reads.length, 0);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("host options do not bypass default missing-policy gate", async () => {
  const reader = dependencyReaderFixture();
  const f = await fixture(
    () => text("must not run"),
    false,
    (ctx) => reader.register(ctx),
  );
  try {
    await assert.rejects(
      executeAgentWithoutPolicy(
        f.ctx,
        f.exec,
        { prompt: "inspect reference" },
        f.exec.signal,
        undefined,
        undefined,
        undefined,
        reader.hostOptions,
        hostDependencyContext("no-policy"),
      ),
      /RUNTIME_AGENT_POLICY_UNSUPPORTED/,
    );
    assert.equal(reader.bound.length, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.bodies, []);
  } finally {
    await f.close();
  }
});

test("throwing host model wait callback preserves output and reader release", async () => {
  const reader = dependencyReaderFixture();
  const notifications = [];
  const f = await fixture(
    () => text("observer cannot disrupt this output"),
    false,
    (ctx) => reader.register(ctx),
  );
  try {
    const result = await executeAgentWithoutPolicy(
      f.ctx,
      f.exec,
      { prompt: "inspect reference" },
      f.exec.signal,
      undefined,
      undefined,
      f.policy,
      {
        ...reader.hostOptions,
        onModelWait(id, status) {
          notifications.push({ id, status });
          throw Error("observer failure");
        },
      },
      hostDependencyContext("observed"),
    );
    assert.equal(result.output, "observer cannot disrupt this output");
    assert.ok(notifications.length > 0);
    assert.ok(notifications.every((entry) => entry.id === result.sessionId));
    assert.equal(notifications.at(-1).status, undefined);
    assert.equal(reader.released.length, 1);
    assert.equal(reader.released[0].id, result.sessionId);
    assert.equal(reader.bindings.size, 0);
  } finally {
    await f.close();
  }
});

test("host dependency binding releases when subsequent child setup fails", async () => {
  const reader = dependencyReaderFixture();
  const f = await fixture(
    () => text("must not run"),
    false,
    (ctx) => reader.register(ctx),
  );
  const presets = f.ctx.agentPresets;
  const originalCompose = presets.composeFrom;
  presets.composeFrom = () => {
    throw Error("fixture child setup failure after bind");
  };
  try {
    await assert.rejects(
      executeAgentWithoutPolicy(
        f.ctx,
        f.exec,
        { prompt: "inspect reference" },
        f.exec.signal,
        undefined,
        undefined,
        f.policy,
        reader.hostOptions,
        hostDependencyContext("setup-failure"),
      ),
      /RUNTIME_AGENT_EXECUTION_FAILED/,
    );
    assert.equal(reader.bound.length, 1);
    assert.equal(reader.released.length, 1);
    assert.equal(reader.released[0], reader.bound[0].agent);
    assert.equal(reader.bindings.size, 0);
    assert.equal(reader.reads.length, 0);
    assert.equal(f.requests.length, 0);
  } finally {
    presets.composeFrom = originalCompose;
    await f.close();
  }
});
