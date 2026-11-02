import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RunStore } from "../dist/runtime/store.js";
import { RuntimeExecutor } from "../dist/runtime/executor.js";
import { parsePlan } from "../dist/runtime/plan.js";
import { runInstallSmoke } from "../scripts/install-smoke.mjs";

test("install smoke cannot recover or prune the operator's home or explicit run root", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-install-isolation-"));
  try {
    const home = path.join(root, "operator-home");
    const defaultRoot = path.join(home, "tmp", "xiaohe-runtime", "runs");
    const explicitRoot = path.join(root, "operator-records");
    const temp = path.join(root, "smoke");
    mkdirSync(temp);
    for (const dir of [defaultRoot, explicitRoot]) {
      const store = new RunStore(dir);
      const executor = new RuntimeExecutor(store, async () => null);
      const plan = parsePlan({
        steps: [{ id: "read", tool: "read", input: {} }],
      });
      for (let i = 0; i < 101; i++) {
        const run = executor.createRun("sentinel-owner", plan);
        executor.cancel(run);
      }
      const abandoned = executor.createRun("sentinel-owner", plan);
      delete abandoned.ownerPid;
      delete abandoned.ownerProcess;
      store.save(abandoned);
    }
    const snapshot = (dir) =>
      readdirSync(dir)
        .sort()
        .map((name) => [name, readFileSync(path.join(dir, name), "utf8")]);
    const before = [snapshot(defaultRoot), snapshot(explicitRoot)];
    const source =
      "import { apply } from " +
      JSON.stringify(pathToFileURL(path.resolve("dist/plugin.js")).href) +
      ";\n" +
      "const disposers=[];apply({effect(fn){disposers.push(fn())},tools:{register(){}}});for(const dispose of disposers)await dispose();\n";
    const script = path.join(temp, "verify.mjs");
    writeFileSync(script, source);
    for (const override of [undefined, explicitRoot]) {
      const env = { ...process.env, DSH_HOME: home };
      if (override) env.XIAOHE_RUNTIME_DIR = override;
      else delete env.XIAOHE_RUNTIME_DIR;
      const child = runInstallSmoke(script, temp, env);
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0);
      assert.deepEqual([snapshot(defaultRoot), snapshot(explicitRoot)], before);
    }
    assert.equal(existsSync(path.join(temp, "records")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
