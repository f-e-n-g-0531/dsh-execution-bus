import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PRODUCT,
  RUNTIME_RUN_DESCRIPTION,
  RUNTIME_RUN_PARAMETERS,
  RUNTIME_INSTRUCTIONS,
} from "../dist/product.js";
import * as plugin from "../dist/plugin.js";
import * as mode from "../dist/mode.js";
import * as legacy from "../dist/test-mode.js";
import { derivePreset } from "../dist/preset.js";

test("formal product entry and compatibility export share implementation and identity", async () => {
  const formal = await import("@feng0531/dsh-execution-bus/mode");
  const old = await import("@feng0531/dsh-execution-bus/test-mode");
  assert.equal(formal, old);
  assert.equal(formal.apply, legacy.apply);
  assert.equal(mode.name, PRODUCT.modePluginName);
  const definition = derivePreset("[]");
  assert.equal(definition.id, PRODUCT.presetId);
  assert.equal(definition.plugins.at(-1).name, PRODUCT.modeEntry);
  assert.equal(definition.plugins.at(-1).id, "xiao-he-runtime");
  const pkg = JSON.parse(readFileSync("package.json"));
  assert.equal(pkg.exports["./mode"], "./dist/mode.js");
  assert.equal(pkg.exports["./test-mode"], pkg.exports["./mode"]);
});

test("product schema, descriptions and prompt stay on one runtime contract", async () => {
  assert.equal(PRODUCT.presetId, "xiao-he-runtime");
  assert.equal(RUNTIME_RUN_PARAMETERS.properties.plan.properties.steps.maxItems, 32);
  assert.equal(RUNTIME_RUN_PARAMETERS.properties.plan.properties.steps.items.properties.retry.maximum, 3);
  assert.match(RUNTIME_RUN_DESCRIPTION, /DAG/);
  assert.match(RUNTIME_INSTRUCTIONS, /runtime_run/);
  const dir = mkdtempSync(path.join(os.tmpdir(), "xiaohe-product-"));
  process.env.XIAOHE_RUNTIME_DIR = dir;
  const tools = [];
  const disposers = [];
  try {
    plugin.apply({
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
      tools.map((tool) => tool.name).sort(),
      ["runtime_cancel", "runtime_result", "runtime_resume", "runtime_run", "runtime_status"],
    );
    for (const tool of tools) assert.equal(typeof tool.execute, "function");
  } finally {
    for (const dispose of disposers) await dispose();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.XIAOHE_RUNTIME_DIR;
  }
});
