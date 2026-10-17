import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
import { globHandler, grepHandler } from "../dist/handlers.js";

/** 真实 Cordis/ToolRuntime/Jobs + 宿主工具桩：验证按 handler 名转发与幂等分流，
 *  不把桩冒充真实 glob/grep 实现（真实包需要 ripgrep 与 subprocess 服务）。 */
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
  const stub = (name, produce) => ({
    name,
    description: "stub " + name,
    parameters: { type: "object", additionalProperties: true },
    output: { schema: {}, render: () => [] },
    async execute(args) {
      calls.push({ tool: name, args });
      return produce(args);
    },
  });
  ctx.tools.register(
    stub("glob", () => ({ root: ".", paths: ["src/a.ts", "src/b.ts"] })),
  );
  ctx.tools.register(
    stub("grep", () => ({
      matches: [{ path: "src/a.ts", lineNumber: 3, line: "const bus = 1;" }],
    })),
  );
  const agent = { id: "search-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("host-search-test");
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

test("host.glob 经总线转发并按同名宿主工具执行", async () => {
  const { scope, run, calls } = await fixture();
  try {
    const r = await run(message("host.glob", { pattern: "**/*.ts" }));
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.state, "succeeded");
    assert.deepEqual(r.value.result, { root: ".", paths: ["src/a.ts", "src/b.ts"] });
    assert.deepEqual(calls, [{ tool: "glob", args: { pattern: "**/*.ts" } }]);
  } finally {
    await scope.dispose();
  }
});

test("host.glob 只读幂等：终态结果复用不重新执行", async () => {
  const { scope, run, calls } = await fixture();
  try {
    const m = message("host.glob", { pattern: "*.ts", path: "src" }, "glob-once");
    const first = await run(m);
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(first.value.state, "succeeded");
    const second = await run({ ...m, messageId: randomUUID() });
    assert.equal(second.isError, false, JSON.stringify(second));
    assert.equal(second.value.state, "succeeded");
    assert.deepEqual(second.value.result, first.value.result);
    assert.equal(calls.length, 1);
  } finally {
    await scope.dispose();
  }
});

test("host.grep 经总线转发并返回宿主工具结果", async () => {
  const { scope, run, calls } = await fixture();
  try {
    const r = await run(
      message("host.grep", { pattern: "bus", include: "*.ts" }),
    );
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.state, "succeeded");
    assert.deepEqual(r.value.result, {
      matches: [{ path: "src/a.ts", lineNumber: 3, line: "const bus = 1;" }],
    });
    assert.deepEqual(calls, [{ tool: "grep", args: { pattern: "bus", include: "*.ts" } }]);
  } finally {
    await scope.dispose();
  }
});

test("host.glob 与 host.grep 的非法参数在受理前被拒绝", async () => {
  const { scope, run } = await fixture();
  try {
    const cases = [
      ["host.glob", {}, /INVALID_GLOB_INPUT/],
      ["host.glob", { pattern: "  " }, /INVALID_GLOB_INPUT/],
      ["host.glob", { pattern: "a", extra: 1 }, /INVALID_GLOB_INPUT/],
      ["host.glob", { pattern: "a", path: "  " }, /INVALID_GLOB_INPUT/],
      ["host.grep", { pattern: "" }, /INVALID_GREP_INPUT/],
      ["host.grep", { pattern: "a", include: "!x" }, /INVALID_GREP_INPUT/],
      ["host.grep", { pattern: "a", include: "*.ts,*.js" }, /INVALID_GREP_INPUT/],
      ["host.grep", { pattern: "a", path: "  " }, /INVALID_GREP_INPUT/],
      ["host.grep", { pattern: "a", case_sensitive: true }, /INVALID_GREP_INPUT/],
    ];
    for (const [handler, input, pattern] of cases) {
      const r = await run(message(handler, input));
      assert.equal(r.isError, true, JSON.stringify({ handler, input, r }));
      assert.match(JSON.stringify(r), pattern);
    }
  } finally {
    await scope.dispose();
  }
});

test("搜索类 Handler 显式声明幂等，写类 Handler 不因本扩展变成幂等", () => {
  assert.equal(globHandler.idempotent, true);
  assert.equal(grepHandler.idempotent, true);
});
