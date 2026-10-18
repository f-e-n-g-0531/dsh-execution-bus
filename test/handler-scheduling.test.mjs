import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const calls = { read: 0, edit: 0 };
  let editActive = 0;
  let editPeak = 0;
  const stub = (name, run) => ({
    name,
    description: "stub " + name,
    parameters: { type: "object", additionalProperties: true },
    output: { schema: {}, render: () => [] },
    async execute(args) { calls[name]++; return run(args); },
  });
  ctx.tools.register(stub("read", async () => ({ content: "stub", truncated: false })));
  ctx.tools.register(stub("edit", async (args) => {
    editActive++;
    editPeak = Math.max(editPeak, editActive);
    await sleep(40);
    editActive--;
    return { ok: true, file_path: args.file_path };
  }));
  const agent = { id: "scheduling-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("handler-scheduling-test");
  plugin.apply(scope.ctx);
  const run = (args) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId: randomUUID(),
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  return { scope, run, calls, peak: () => editPeak };
}

test("内置只读 Handler 不启用 payload 去重：不同 requestId 相同输入会重新执行", async () => {
  const { scope, run, calls } = await fixture();
  try {
    const input = { file_path: "README.md", limit: 2 };
    const first = await run({ requestId: "unique-1", handler: "host.read", input });
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(first.value.state, "succeeded");
    assert.equal(first.value.reused, undefined);
    assert.equal(calls.read, 1);
    const second = await run({ requestId: "unique-2", handler: "host.read", input });
    assert.equal(second.isError, false, JSON.stringify(second));
    assert.equal(second.value.state, "succeeded");
    assert.equal(second.value.reused, undefined, "0.12.1 起内置 host.* 不缓存旧文件内容");
    assert.equal(calls.read, 2);
    const third = await run({ requestId: "unique-3", handler: "host.read", input: { file_path: "README.md", limit: 3 } });
    assert.equal(third.value.state, "succeeded");
    assert.equal(calls.read, 3);
  } finally {
    await scope.dispose();
  }
});

test("内置写 Handler 按 file_path 资源互斥：同文件串行、不同文件并行", async () => {
  const { scope, run, peak } = await fixture();
  try {
    const same = await Promise.all([
      run({ requestId: "edit-a1", handler: "host.edit", input: { file_path: "same.txt", old_string: "a", new_string: "b" } }),
      run({ requestId: "edit-a2", handler: "host.edit", input: { file_path: "same.txt", old_string: "c", new_string: "d" } }),
    ]);
    for (const r of same) assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(peak(), 1);
    const before = peak();
    const different = await Promise.all([
      run({ requestId: "edit-b1", handler: "host.edit", input: { file_path: "b.txt", old_string: "a", new_string: "b" } }),
      run({ requestId: "edit-c1", handler: "host.edit", input: { file_path: "c.txt", old_string: "a", new_string: "b" } }),
    ]);
    for (const r of different) assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(before, 1);
    assert.equal(peak(), 2, "different files should run concurrently");
  } finally {
    await scope.dispose();
  }
});
