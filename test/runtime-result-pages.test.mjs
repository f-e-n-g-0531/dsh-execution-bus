import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";
import { createServiceContext } from "./fixtures/service-context.mjs";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";

const exec = (id = "owner") => ({
  agent: { id },
  callId: "pages",
  signal: new AbortController().signal,
});
test("owner result pages round-trip JSON without splitting Unicode or changing legacy values", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-pages-"));
  const value = {
    text: '中文😀\n"'.repeat(2500),
    zero: 0,
    empty: "",
    flag: false,
    nothing: null,
  };
  let calls = 0;
  const service = new RuntimeService(
    createServiceContext(async () => {
      calls++;
      return value;
    }),
    new RunStore(dir),
  );
  try {
    const run = await service.run(
      { plan: { steps: [{ id: "a", tool: "read", input: {} }] } },
      exec(),
    );
    assert.equal(run.executionSettled, true);
    const legacy = service.result({ runId: run.runId }, exec());
    assert.deepEqual(legacy.results.a.value, value);
    let offset = 0,
      hash,
      combined = "";
    do {
      const result = service.result(
        {
          runId: run.runId,
          stepId: "a",
          offset,
          limit: 73,
          ...(hash ? { hash } : {}),
        },
        exec(),
      );
      assert.deepEqual(
        validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_result, result),
        [],
      );
      assert.deepEqual(result.results, {});
      const metadata = JSON.stringify(runtimePresentationMeta({}, result));
      assert.equal(metadata.includes("中文"), false);
      assert.equal(metadata.includes(result.page.hash), false);
      assert.ok(Buffer.byteLength(result.page.text) <= 73 * 4);
      hash ??= result.page.hash;
      assert.equal(result.page.hash, hash);
      combined += result.page.text;
      offset = result.page.nextOffset;
    } while (offset !== undefined);
    assert.deepEqual(JSON.parse(combined), value);
    const eof = service.result(
      { runId: run.runId, stepId: "a", offset: Array.from(combined).length },
      exec(),
    );
    assert.equal(eof.page.text, "");
    assert.equal(eof.page.nextOffset, undefined);
    const restored = new RuntimeService(
      createServiceContext(async () => {
        throw Error("must not execute");
      }),
      new RunStore(dir),
    );
    try {
      assert.equal(
        restored.result(
          { runId: run.runId, stepId: "a", limit: 1, hash },
          exec(),
        ).page.hash,
        hash,
      );
    } finally {
      await restored.dispose();
    }
    assert.equal(calls, 1);
    for (const bad of [
      { offset: 1 },
      { limit: 1 },
      { stepId: "a", limit: 0 },
      { stepId: "a", limit: 4097 },
      { stepId: "a", offset: -1 },
      { stepId: "a", offset: 1.5 },
      { stepId: "a", offset: Number.MAX_SAFE_INTEGER },
    ])
      assert.throws(
        () => service.result({ runId: run.runId, ...bad }, exec()),
        /INVALID_PLAN/,
      );
    assert.throws(
      () =>
        service.result(
          { runId: run.runId, stepId: "a", hash: "wrong" },
          exec(),
        ),
      /RUNTIME_RESULT_CHANGED/,
    );
    for (const id of ["other", "child"])
      assert.throws(
        () => service.result({ runId: run.runId, stepId: "a" }, exec(id)),
        /RUNTIME_NOT_FOUND/,
      );
    assert.throws(
      () => service.result({ runId: run.runId, stepId: "constructor" }, exec()),
      /RUNTIME_NOT_FOUND/,
    );
    assert.throws(
      () => service.cancel({ runId: run.runId, stepId: "a" }, exec()),
      /INVALID_PLAN/,
    );
    assert.throws(
      () => service.result({ runId: run.runId, stepId: "a" }, {}),
      /OWNING_SESSION_REQUIRED/,
    );
  } finally {
    await service.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paging never reconstructs truncated results or enables unsupported workers", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-page-limit-"));
  const service = new RuntimeService(
    createServiceContext(async () => "x".repeat(65537)),
    new RunStore(dir),
  );
  try {
    const run = await service.run(
      { plan: { steps: [{ id: "a", tool: "read", input: {} }] } },
      exec(),
    );
    assert.equal(
      service.result({ runId: run.runId }, exec()).results.a.truncated,
      true,
    );
    assert.throws(
      () => service.result({ runId: run.runId, stepId: "a" }, exec()),
      /RUNTIME_RESULT_UNAVAILABLE/,
    );
    await assert.rejects(
      service.run(
        {
          plan: {
            steps: [{ id: "w", tool: "agent", input: { prompt: "inspect" } }],
          },
        },
        exec(),
      ),
      /RUNTIME_AGENT_POLICY_UNSUPPORTED/,
    );
  } finally {
    await service.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
