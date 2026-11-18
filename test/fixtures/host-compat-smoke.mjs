import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { createScope } from "@deepseek-ai/dsh-scope";

const require = createRequire(import.meta.url);
export function hostIdentity() {
  return Object.fromEntries(["cordis", "dsh-tools", "dsh-scope", "dsh-system-prompt", "dsh-agent"].map(name => {
    const bytes = readFileSync(require.resolve("@deepseek-ai/" + name + "/package.json"));
    const manifest = JSON.parse(bytes);
    return [manifest.name, { version: manifest.version, manifestSha256: createHash("sha256").update(bytes).digest("hex") }];
  }));
}

// Real host registry, scopes and policy pipeline; ordinary tool bodies and agent
// factory are controlled probes. This is not an OS sandbox or model/network test.
export async function runHostSmoke(candidateDirectory, version = "unspecified") {
  const checks = [], evidence = {};
  const pass = (name, fn) => { fn(); checks.push(name); };
  const dir = mkdtempSync(path.join(tmpdir(), "host-smoke-"));
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  const ctx = new Context(), scopes = [];
  let outcome;
  try {
    process.env.XIAOHE_RUNTIME_DIR = dir;
    const load = relative => import(pathToFileURL(path.join(candidateDirectory, relative)).href);
    const plugin = await load("dist/plugin.js");
    const { executeHostTool } = await load("dist/runtime/host-compat.js");
    const { derivePreset } = await load("dist/preset.js");
    const mode = await load("dist/mode.js");
    new SystemPrompt(ctx, {}); new ToolRuntime(ctx, {});
    const cwd = dir;
    ctx.provide("workingDirectory");
    ctx.set("workingDirectory", { defaultDirectory: cwd, get: () => cwd, ensure: async () => cwd, set: async () => cwd });
    const agents = new Map();
    let creations = 0, agentToolCalls = 0, writes = 0;
    ctx.provide("agents");
    ctx.set("agents", { get: id => agents.get(id), create() { creations++; throw Error("SMOKE_UNEXPECTED_WORKER_CREATION"); } });
    const observations = [];
    ctx.on("tools/pre-execute", async (exec, next) => {
      observations.push({ name: exec.name, token: exec.token, parent: exec.parent, rootCallId: exec.rootCallId, agent: exec.agent });
      if (exec.name === "write" && exec.parent !== undefined) return { kind: "deny", reason: "SMOKE_NESTED_WRITE_DENIED" };
      return next();
    });
    const register = (name, execute) => ctx.tools.register({ name, description: "compatibility probe " + name,
      parameters: { type: "object", additionalProperties: true }, output: { schema: {}, render: () => [] }, execute });
    register("read", async args => ({ content: String(args.file_path), truncated: false }));
    register("write", async () => { writes++; return { ok: true }; });
    register("agent", async () => { agentToolCalls++; return { probe: true }; });
    const owner = id => {
      const agent = { id, session: { header: { cwd } } };
      const scope = createScope(ctx, agent); scopes.push(scope); agent.ctx = scope.ctx; agents.set(id, agent);
      // Actually register the plugin in BOTH owner scopes, not just import it.
      plugin.apply(scope.ctx);
      return { agent, call: (name, args) => executeHostTool(ctx, { name, arguments: args, callId: randomUUID(), agent, signal: new AbortController().signal }) };
    };
    const a = owner("smoke-owner-a"), b = owner("smoke-owner-b");
    const ok = result => { assert.equal(result.isError, false, JSON.stringify(result)); return result.value; };
    const denied = (result, code) => { assert.equal(result.isError, true, JSON.stringify(result)); assert.match(JSON.stringify(result), new RegExp(code)); };
    pass("plugin entry/preset/mode", () => { assert.equal(plugin.name, "xiao-he-runtime"); assert.equal(typeof derivePreset, "function"); assert.equal(typeof mode.apply, "function"); });
    const direct = ok(await a.call("read", { file_path: "direct-control" }));
    pass("registered ordinary read positive control", () => assert.equal(direct.content, "direct-control"));
    ok(await a.call("write", { file_path: "control", content: "probe" }));
    ok(await a.call("agent", { prompt: "registration control only" }));
    pass("write and agent tools registered positive controls", () => { assert.equal(writes, 1); assert.equal(agentToolCalls, 1); });
    observations.length = 0;
    const runA = ok(await a.call("runtime_run", { plan: { steps: [{ id: "file", tool: "read", input: { file_path: "private-a" } }] } }));
    pass("registered runtime_run ordinary DAG succeeds", () => assert.equal(runA.state, "succeeded"));
    const [outer, nested] = observations;
    pass("actual root/parent/owner propagation", () => {
      assert.deepEqual(observations.map(x => x.name), ["runtime_run", "read"]);
      assert.ok(outer.token); assert.ok(outer.rootCallId);
      assert.equal(nested.parent, outer.token); assert.equal(nested.rootCallId, outer.rootCallId);
      assert.equal(outer.agent, a.agent); assert.equal(nested.agent, a.agent);
    });
    evidence.identityPropagation = { parentMatchesToken: true, rootMatches: true, ownerMatches: true };
    const blocked = ok(await a.call("runtime_run", { plan: { steps: [{ id: "blocked", tool: "write", input: { file_path: "never-write", content: "no" } }] } }));
    pass("registered nested write denied by concrete host policy", () => {
      assert.equal(blocked.state, "failed"); assert.equal(blocked.steps[0].error, "RUNTIME_STEP_FAILED"); assert.equal(writes, 1);
      const write = observations.findLast(x => x.name === "write"); assert.ok(write?.parent);
    });
    // Check the exact host denial separately: runtime intentionally normalizes it.
    const policyResult = await executeHostTool(ctx, { name: "write", arguments: {}, callId: randomUUID(), parent: outer.token, rootCallId: outer.rootCallId, agent: a.agent, signal: new AbortController().signal });
    pass("specific nested host denial reason", () => denied(policyResult, "SMOKE_NESTED_WRITE_DENIED"));
    const runB = ok(await b.call("runtime_run", { plan: { steps: [{ id: "file", tool: "read", input: { file_path: "private-b" } }] } }));
    pass("second owner ordinary DAG succeeds", () => assert.equal(runB.state, "succeeded"));
    for (const [own, peer, run, marker] of [[a, b, runA, "private-a"], [b, a, runB, "private-b"]]) {
      for (const tool of ["runtime_status", "runtime_result", "runtime_cancel"]) {
        const foreign = await peer.call(tool, { runId: run.runId });
        pass(tool + " foreign owner rejected " + own.agent.id, () => { denied(foreign, "RUNTIME_NOT_FOUND"); assert.doesNotMatch(JSON.stringify(foreign), new RegExp(marker)); });
        const ownResult = ok(await own.call(tool, { runId: run.runId }));
        pass(tool + " own owner positive control " + own.agent.id, () => {
          assert.equal(ownResult.runId, run.runId);
          assert.equal(ownResult.state, "succeeded");
          if (tool === "runtime_result") assert.equal(ownResult.results.file.value.content, marker);
        });
      }
      const list = ok(await own.call("runtime_status", {}));
      pass("owner list isolation " + own.agent.id, () => { assert.ok(list.runs.some(x => x.runId === run.runId)); assert.ok(!list.runs.some(x => x.runId === (own === a ? runB : runA).runId)); });
    }
    const before = ok(await a.call("runtime_status", {})).runs.map(x => x.runId).sort();
    const gate = await a.call("runtime_run", { plan: { steps: [{ id: "worker", tool: "agent", input: { prompt: "must not create worker" } }] } });
    const after = ok(await a.call("runtime_status", {})).runs.map(x => x.runId).sort();
    pass("standard runtime_run agent gate exact error and zero creation", () => {
      denied(gate, "RUNTIME_AGENT_POLICY_UNSUPPORTED"); assert.equal(creations, 0); assert.equal(agentToolCalls, 1); assert.deepEqual(after, before);
    });
    evidence.workerGate = { error: "RUNTIME_AGENT_POLICY_UNSUPPORTED", creations, agentToolCallsAfterControl: agentToolCalls - 1, newRuns: after.length - before.length };
    const { RunStore } = await load("dist/runtime/store.js");
    const { RuntimeExecutor } = await load("dist/runtime/executor.js");
    const { parsePlan } = await load("dist/runtime/plan.js");
    const store = new RunStore(dir);
    const interrupted = new RuntimeExecutor(store, () => assert.fail("fixture must not dispatch")).createRun(
      a.agent.id, parsePlan({ steps: [{ id: "worker", tool: "agent", input: { prompt: "must not resume worker" } }] }),
    );
    Object.assign(interrupted, { state: "interrupted", error: "RUNTIME_INTERRUPTED", finishedAt: interrupted.updatedAt });
    store.save(interrupted);
    const read = () => readFileSync(store.pathFor(interrupted.runId));
    const saved = read();
    assert.equal(ok(await a.call("runtime_status", { runId: interrupted.runId })).state, "interrupted");
    observations.length = 0;
    const resume = await a.call("runtime_resume", { runId: interrupted.runId });
    pass("standard runtime_resume agent gate preserves interrupted checkpoint", () => {
      denied(resume, "RUNTIME_AGENT_POLICY_UNSUPPORTED");
      assert.deepEqual(read(), saved);
      assert.deepEqual(observations.map(x => x.name), ["runtime_resume"]);
      assert.equal(creations, 0);
      assert.equal(agentToolCalls, 1);
    });
    evidence.workerResumeGate = { error: "RUNTIME_AGENT_POLICY_UNSUPPORTED", creations, checkpointUnchanged: true, nestedCalls: 0 };
    outcome = { status: "passed", version, host: hostIdentity(), checks, evidence };
  } catch (error) {
    outcome = { status: "failed", version, checks, evidence, error: String(error?.stack ?? error) };
  } finally {
    try { for (const scope of scopes.reverse()) await scope.dispose(); await ctx.dispose?.(); }
    catch (error) { outcome = { ...outcome, status: "failed", cleanupError: String(error?.stack ?? error) }; }
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.XIAOHE_RUNTIME_DIR; else process.env.XIAOHE_RUNTIME_DIR = previous;
  }
  return outcome;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const candidate = process.argv[3] ?? path.dirname(require.resolve("@feng0531/dsh-execution-bus/package.json"));
  const result = await runHostSmoke(candidate, process.argv[2]);
  console.log(JSON.stringify(result));
  if (result.status !== "passed") process.exitCode = 1;
}
