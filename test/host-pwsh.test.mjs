import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
import { pwshHandler } from "../dist/handlers.js";

/** 真实 Cordis/ToolRuntime/Jobs + pwsh 工具桩：验证命令参数原样转发、
 *  非幂等终态复用拒绝与失败固定码；不冒充真实 pwsh/shell/sandbox 组合。 */
async function fixture() {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  const cwd = process.cwd();
  ctx.provide("workingDirectory");
  ctx.set("workingDirectory", {
    defaultDirectory: cwd,
    get: () => cwd,
    ensure: async () => cwd,
    set: async () => cwd,
  });
  const calls = [];
  ctx.tools.register({
    name: "pwsh",
    description: "stub pwsh",
    parameters: { type: "object", additionalProperties: true },
    output: { schema: {}, render: () => [] },
    async execute(args) {
      calls.push(args);
      if (args.command === "throw") throw new Error("stub command failed");
      return {
        kind: "foreground",
        cwd,
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: args.timeoutMs ?? 120000,
        stdout: { text: "stub-output\n", truncated: false },
        stderr: { text: "", truncated: false },
      };
    },
  });
  const agent = { id: "pwsh-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("host-pwsh-test");
  plugin.apply(scope.ctx);
  const run = (args) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId: randomUUID(),
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  return { ctx, scope, run, calls };
}

const message = (handler, input, id = randomUUID()) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type: "request",
  payload: { handler, input },
});

test("host.pwsh 经总线转发命令与可选参数", async () => {
  const { scope, run, calls } = await fixture();
  try {
    const input = {
      description: "Print a greeting",
      command: "Write-Output hi",
      timeoutMs: 5000,
      workdir: process.cwd(),
      run_in_background: false,
    };
    const r = await run(message("host.pwsh", input));
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.state, "succeeded");
    assert.equal(r.value.result.kind, "foreground");
    assert.equal(r.value.result.stdout.text, "stub-output\n");
    assert.deepEqual(calls, [input]);
  } finally {
    await scope.dispose();
  }
});

test("host.pwsh 非幂等：终态复用被 MUTATING_REUSE_DENIED 拒绝", async () => {
  const { scope, run, calls } = await fixture();
  try {
    const m = message(
      "host.pwsh",
      { description: "Run once", command: "Write-Output once" },
      "pwsh-once",
    );
    const first = await run(m);
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(first.value.state, "succeeded");
    const second = await run({ ...m, messageId: randomUUID() });
    assert.equal(second.isError, true);
    assert.match(JSON.stringify(second), /MUTATING_REUSE_DENIED/);
    assert.equal(calls.length, 1);
  } finally {
    await scope.dispose();
  }
});

test("host.pwsh 参数非法在受理前被拒绝", async () => {
  const { scope, run } = await fixture();
  try {
    const cases = [
      {},
      { description: "d" },
      { command: "echo hi" },
      { description: "  ", command: "echo hi" },
      { description: "d", command: "  " },
      { description: "d", command: "echo hi", timeoutMs: 0 },
      { description: "d", command: "echo hi", run_in_background: "yes" },
      { description: "d", command: "echo hi", workdir: 3 },
      { description: "d", command: "echo hi", sandbox_permissions: "read-only" },
      { description: "d", command: "echo hi", sandbox_permissions: "workspace-write" },
      { description: "d", command: "echo hi", justification: "need it" },
      { description: "d", command: "echo hi", extra: true },
    ];
    for (const input of cases) {
      const r = await run(message("host.pwsh", input));
      assert.equal(r.isError, true, JSON.stringify({ input, r }));
      assert.match(JSON.stringify(r), /INVALID_PWSH_INPUT/);
    }
  } finally {
    await scope.dispose();
  }
});

test("host.pwsh 宿主工具失败经总线结算为 failed/HANDLER_FAILED", async () => {
  const { scope, run } = await fixture();
  try {
    const r = await run(
      message("host.pwsh", { description: "Fail", command: "throw" }),
    );
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.state, "failed");
    assert.equal(r.value.error, "HANDLER_FAILED");
  } finally {
    await scope.dispose();
  }
});

test("host.pwsh 显式非幂等声明", () => {
  assert.equal(pwshHandler.idempotent, false);
});
