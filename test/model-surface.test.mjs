import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../dist/plugin.js";
import * as product from "../dist/product.js";
import {
  RUNTIME_OUTPUT_SCHEMAS,
  runtimePresentationMeta,
} from "../dist/presentation.js";
import { WORKER_ROLE_INSTRUCTIONS } from "../dist/runtime/agent-trace.js";
import { WORKER_REPORT_INSTRUCTIONS } from "../dist/runtime/agent-report.js";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

// Budget counts UTF-16 code units, not tokens. Increase only after reviewing the
// actual model-visible contract; output schemas are checked separately.
test("registered model surface stays within budget and matches schemas and instructions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-surface-"));
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  process.env.XIAOHE_RUNTIME_DIR = root;
  const tools = [],
    disposers = [];
  try {
    apply({
      effect(fn) {
        disposers.push(fn());
      },
      tools: {
        register(tool) {
          tools.push(tool);
        },
      },
    });
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      Object.keys(RUNTIME_OUTPUT_SCHEMAS).sort(),
    );
    const names = new Set(tools.map((t) => t.name));
    for (const name of product.RUNTIME_INSTRUCTIONS.match(/runtime_[a-z_]+/g))
      assert.ok(
        names.has(name),
        "Prompt references unregistered tool: " + name,
      );
    let size = product.RUNTIME_INSTRUCTIONS.length;
    for (const tool of tools) {
      const prefix = tool.name.toUpperCase();
      assert.equal(tool.description, product[prefix + "_DESCRIPTION"]);
      const parameters =
        product[prefix + "_PARAMETERS"] ?? product.RUNTIME_RUN_ID_PARAMETERS;
      assert.deepEqual(tool.parameters, parameters);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.equal(tool.output.schema, RUNTIME_OUTPUT_SCHEMAS[tool.name]);
      size += JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
    }
    assert.ok(
      size <= 14000,
      "Lead model surface exceeded 14000 characters: " + size,
    );
    assert.ok(
      WORKER_ROLE_INSTRUCTIONS.length + WORKER_REPORT_INSTRUCTIONS.length <=
        9000,
    );
    assert.match(product.RUNTIME_INSTRUCTIONS, /rc\.3.*可信父策略适配器/);
    assert.match(
      product.RUNTIME_INSTRUCTIONS,
      /accepted不证明独立验收或人工批准/,
    );
    assert.match(
      product.RUNTIME_INSTRUCTIONS,
      /sent不证明送达、阅读、解决或验收/,
    );
    assert.match(
      product.RUNTIME_INSTRUCTIONS,
      /runtime_task.*不是全量历史或自动续跑/,
    );
    assert.match(product.RUNTIME_NOTIFICATION_DESCRIPTION, /不发送消息/);
    assert.match(product.RUNTIME_RESULT_DESCRIPTION, /截断|truncated/);
    assert.equal(names.has("runtime_deliver"), false);
    const cap = await tools
      .find((t) => t.name === "runtime_capabilities")
      .execute({}, { agent: { id: "surface" } });
    assert.equal(cap.worker, "unavailable");
    assert.deepEqual(
      validateJsonSchemaValue(RUNTIME_OUTPUT_SCHEMAS.runtime_capabilities, cap),
      [],
    );
    const rendered = tools[0].output.render({}, { text: "完整结果" });
    assert.deepEqual(JSON.parse(rendered[0].text), { text: "完整结果" });
  } finally {
    for (const dispose of disposers) await dispose();
    if (previous === undefined) delete process.env.XIAOHE_RUNTIME_DIR;
    else process.env.XIAOHE_RUNTIME_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("task cards retain task lineage and explicit next actor without exposing payloads", () => {
  const meta = runtimePresentationMeta(
    {},
    {
      runId: "run-card",
      state: "failed",
      taskId: "audit",
      previousRunId: "run-before",
      action: {
        kind: "inspect_failure",
        actor: "owner",
        message: "由 owner 检查失败",
      },
      results: { secret: "PRIVATE_RESULT" },
      plan: { input: "PRIVATE_INPUT" },
      ownerSessionId: "PRIVATE_OWNER",
    },
  );
  assert.match(meta.text, /当前行动.*owner/);
  assert.match(meta.text, /任务：audit/);
  assert.match(meta.text, /前次运行：run-before/);
  assert.doesNotMatch(meta.text, /PRIVATE/);
});
