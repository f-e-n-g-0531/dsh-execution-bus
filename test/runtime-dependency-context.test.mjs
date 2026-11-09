import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dependencyContext } from "../dist/runtime/dependency-context.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { RunStore } from "../dist/runtime/store.js";
import { parsePlan } from "../dist/runtime/plan.js";

function fixture(owner = "owner", id = "review") {
  return {
    ownerSessionId: owner,
    runId: "run-a",
    steps: [
      { id: "a", state: "succeeded" },
      { id: "secret", state: "succeeded" },
    ],
    results: {
      a: { value: "😀证据".repeat(2000) },
      secret: { value: "private" },
    },
  };
}
test("dependency references isolate scope, freeze complete JSON and paginate by code points", () => {
  const run = fixture(),
    controller = new AbortController();
  const ctx = dependencyContext(
    run,
    { id: "review", dependsOn: ["a"] },
    controller.signal,
  );
  const p = ctx.previews[0];
  assert.equal(Array.from(p.preview).length, 256);
  assert.notEqual(
    p.ref,
    dependencyContext(
      fixture("other"),
      { id: "review", dependsOn: ["a"] },
      controller.signal,
    ).previews[0].ref,
  );
  assert.notEqual(
    p.ref,
    dependencyContext(run, { id: "other", dependsOn: ["a"] }, controller.signal)
      .previews[0].ref,
  );
  const expected = JSON.stringify(run.results.a.value);
  run.results.a.value = "changed";
  let text = "",
    offset = 0;
  do {
    const page = ctx.read({ ref: p.ref, hash: p.hash, offset, limit: 113 });
    text += page.text;
    offset = page.nextOffset;
  } while (offset !== undefined);
  assert.equal(text, expected);
  assert.throws(
    () => ctx.read({ ref: "secret", hash: p.hash }),
    /RESULT_UNAVAILABLE/,
  );
  assert.throws(
    () => ctx.read({ ref: p.ref, hash: "stale" }),
    /RESULT_CHANGED/,
  );
  for (const input of [
    { ref: p.ref, hash: p.hash, limit: 4097 },
    { ref: p.ref, hash: p.hash, offset: -1 },
    { ref: p.ref, hash: p.hash, runId: "other" },
  ])
    assert.throws(() => ctx.read(input), /INVALID_PLAN/);
  let called = false;
  const getter = {
    get ref() {
      called = true;
      return p.ref;
    },
    hash: p.hash,
  };
  assert.throws(() => ctx.read(getter));
  assert.equal(called, false);
  controller.abort();
  assert.throws(() => ctx.read({ ref: p.ref, hash: p.hash }), /AGENT_ABORTED/);
});
test("missing, truncated or unsuccessful dependencies stay unavailable", () => {
  for (const stored of [
    undefined,
    { truncated: true, bytes: 70000 },
    { value: "ok" },
  ]) {
    const run = fixture();
    run.results.a = stored;
    if (stored?.value) run.steps[0].state = "running";
    assert.throws(
      () =>
        dependencyContext(
          run,
          { id: "review", dependsOn: ["a"] },
          new AbortController().signal,
        ),
      /DEPENDENCY_UNAVAILABLE/,
    );
  }
});
test("opt-in executor avoids aggregate context overflow, revokes references and leaves plan unchanged", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-refs-"));
  try {
    let saved;
    const prompts = [];
    const executor = new RuntimeExecutor(
      new RunStore(dir),
      async (tool, input, signal, created, context) => {
        prompts.push(input.prompt);
        if (!context) return "x".repeat(33000);
        saved = context;
        assert.equal(context.previews.length, 2);
        assert.equal(
          context.read({
            ref: context.previews[0].ref,
            hash: context.previews[0].hash,
          }).text.length,
          2048,
        );
        return "done";
      },
      "runtime_dependency_read",
    );
    const plan = parsePlan({
      steps: [
        { id: "a", tool: "agent", input: { prompt: "a" } },
        { id: "b", tool: "agent", input: { prompt: "b" } },
        {
          id: "review",
          tool: "agent",
          input: { prompt: "review" },
          depends_on: ["a", "b"],
        },
      ],
    });
    const run = executor.createRun("owner", plan);
    await executor.execute(run);
    assert.equal(run.state, "succeeded");
    assert.ok(Buffer.byteLength(prompts[2]) < 3000);
    assert.match(prompts[2], /不可信资料/);
    assert.equal(plan.steps[2].input.prompt, "review");
    assert.throws(
      () =>
        saved.read({
          ref: saved.previews[0].ref,
          hash: saved.previews[0].hash,
        }),
      /AGENT_ABORTED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeout revokes reads before owned invocation finishes cleanup", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-refs-timeout-"));
  try {
    let revoked = false;
    const executor = new RuntimeExecutor(new RunStore(dir), async (_tool, _input, signal, _created, context) => {
      if (!context) return "evidence";
      await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
      const p = context.previews[0];
      assert.throws(() => context.read({ref:p.ref, hash:p.hash}));
      revoked = true;
      return "late result";
    }, "runtime_dependency_read");
    const run = executor.createRun("owner", parsePlan({ steps: [
      { id:"a", tool:"agent", input:{prompt:"a"} },
      { id:"review", tool:"agent", input:{prompt:"review"}, depends_on:["a"], timeout_ms:1000 }
    ] }));
    await executor.execute(run);
    assert.equal(revoked, true);
    assert.equal(run.steps[1].error, "RUNTIME_STEP_TIMEOUT");
    assert.equal(run.results.review, undefined);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
