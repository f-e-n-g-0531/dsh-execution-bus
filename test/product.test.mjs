import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PRODUCT,
  CORE_DEFAULTS,
  ADMISSION_DEFAULTS,
  MODE_INSTRUCTIONS,
} from "../dist/product.js";
import { ExecutionBus } from "../dist/bus.js";
import * as plugin from "../dist/plugin.js";
import * as mode from "../dist/mode.js";
import * as legacy from "../dist/test-mode.js";
import { derivePreset } from "../dist/preset.js";
test("formal product entry and compatibility export share implementation and identity", async () => {
  const formal = await import("@feng0531/dsh-execution-bus/mode"),
    old = await import("@feng0531/dsh-execution-bus/test-mode");
  assert.equal(formal, old);
  assert.equal(formal.apply, legacy.apply);
  assert.equal(mode.name, "execution-bus-mode");
  assert.equal(derivePreset("[]").plugins.at(-1).name, PRODUCT.modeEntry);
  const pkg = JSON.parse(readFileSync("package.json"));
  assert.equal(pkg.exports["./mode"], "./dist/mode.js");
  assert.equal(pkg.exports["./test-mode"], pkg.exports["./mode"]);
});
test("product defaults, tool descriptions and prompt draw from one policy contract", async () => {
  const b = new ExecutionBus();
  assert.deepEqual(b.options, CORE_DEFAULTS);
  assert.ok(
    Object.isFrozen(CORE_DEFAULTS) && Object.isFrozen(ADMISSION_DEFAULTS),
  );
  assert.ok(
    MODE_INSTRUCTIONS.includes(String(ADMISSION_DEFAULTS.sessionQueueLimit)),
  );
  assert.ok(
    MODE_INSTRUCTIONS.includes(
      String(ADMISSION_DEFAULTS.maxQueueWaitMs / 1000),
    ),
  );
  const tools = [],
    disposers = [];
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
  const request = tools.find((t) => t.name === "execution_bus");
  assert.match(request.description, /Diagnostic handler only/);
  assert.equal(tools.filter((t) => t.name === "execution_bus_state").length, 1);
  for (const d of disposers) await d();
  await b.close();
});
