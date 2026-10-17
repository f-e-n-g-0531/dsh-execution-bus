import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import LocalFS from "@deepseek-ai/dsh-fs-local";
import * as fileTools from "@deepseek-ai/dsh-tool-fs";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";

async function fixture(cwd) {
  const ctx = new Context();
  new SystemPrompt(ctx, {});
  new ToolRuntime(ctx, {});
  new LocalFS(ctx, LocalFS.Config({ cwd }));
  ctx.provide("workingDirectory");
  ctx.set("workingDirectory", {
    defaultDirectory: cwd,
    get: () => cwd,
    ensure: async () => cwd,
    set: async () => cwd,
  });
  fileTools.apply(ctx, fileTools.Config({}));
  const agent = { id: "write-agent", session: { header: { cwd } } };
  const scope = createScope(ctx, agent);
  agent.ctx = scope.ctx;
  ctx.provide("agents");
  ctx.set("agents", { get: (id) => (id === agent.id ? agent : undefined) });
  new Jobs(ctx, Jobs.Config({}));
  ctx.jobs.attachController("host-write-test");
  plugin.apply(scope.ctx);
  const run = (args, callId = randomUUID()) =>
    ctx.tools.execute({
      name: "execution_bus",
      callId,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
  return { ctx, agent, scope, run };
}

const message = (handler, input, id = randomUUID()) => ({
  protocolVersion: 1,
  messageId: randomUUID(),
  requestId: id,
  type: "request",
  payload: { handler, input },
});

test("host.write 经总线执行成功并写入文件", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "exec-bus-write-"));
  const file = path.join(dir, "created.txt");
  const { scope, run } = await fixture(dir);
  try {
    const r = await run(
      message("host.write", { file_path: file, content: "written by bus" }),
    );
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(r.value.state, "succeeded");
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file, "utf8"), "written by bus");
  } finally {
    await scope.dispose();
  }
});

test("host.write 非幂等：终态复用被 MUTATING_REUSE_DENIED 拒绝", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "exec-bus-write-"));
  const file = path.join(dir, "once.txt");
  const { scope, run } = await fixture(dir);
  try {
    const m = message(
      "host.write",
      { file_path: file, content: "v1" },
      "write-once",
    );
    const first = await run(m);
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(first.value.state, "succeeded");
    const second = await run({ ...m, messageId: randomUUID() });
    assert.equal(second.isError, true);
    assert.match(JSON.stringify(second), /MUTATING_REUSE_DENIED/);
    assert.equal(readFileSync(file, "utf8"), "v1");
  } finally {
    await scope.dispose();
  }
});

test("host.write 参数非法被拒绝", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "exec-bus-write-"));
  const { scope, run } = await fixture(dir);
  try {
    const r = await run(
      message("host.write", { file_path: path.join(dir, "x.txt") }),
    );
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r), /INVALID_WRITE_INPUT/);
  } finally {
    await scope.dispose();
  }
});
