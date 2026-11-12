import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../dist/plugin.js";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-lazy-"));
  const previous = process.env.XIAOHE_RUNTIME_DIR;
  process.env.XIAOHE_RUNTIME_DIR = root;
  const tools = [], disposers = [];
  apply({ effect(fn) { disposers.push(fn()); }, tools: { register(tool) { tools.push(tool); } } });
  const dispose = async () => { for (const fn of disposers) await fn(); };
  t.after(async () => {
    try { await dispose(); } finally {
      if (previous === undefined) delete process.env.XIAOHE_RUNTIME_DIR;
      else process.env.XIAOHE_RUNTIME_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  return { root, tools, dispose };
}

test("mount is storage-free; every runtime tool rejects a retained lock without modifying it", async (t) => {
  const f = fixture(t);
  assert.deepEqual(readdirSync(f.root), []);
  const lock = path.join(f.root, ".runtime-owner.lock");
  writeFileSync(lock, "crashed-owner");
  assert.equal(f.tools.length, 13);
  for (const tool of f.tools) {
    await assert.rejects(tool.execute({}, {}), /RUNTIME_ROOT_LOCKED/, tool.name);
    assert.equal(readFileSync(lock, "utf8"), "crashed-owner");
    assert.deepEqual(readdirSync(f.root), [".runtime-owner.lock"]);
  }
  await f.dispose();
  await assert.rejects(f.tools[0].execute({}, {}), /CLOSED/);
  assert.equal(readFileSync(lock, "utf8"), "crashed-owner");
});

test("unused disposed plugin cannot initialize storage through a retained tool reference", async (t) => {
  const f = fixture(t);
  await f.dispose();
  await assert.rejects(f.tools[0].execute({}, {}), /CLOSED/);
  assert.deepEqual(readdirSync(f.root), []);
});

test("first invocation acquires ownership and disposal releases it", async (t) => {
  const f = fixture(t);
  const tool = f.tools.find((tool) => tool.name === "runtime_status");
  await assert.rejects(tool.execute({}, {}), /OWNING_SESSION_REQUIRED/);
  const lock = path.join(f.root, ".runtime-owner.lock");
  assert.equal(existsSync(lock), true);
  await f.dispose();
  assert.equal(existsSync(lock), false);
  await assert.rejects(tool.execute({}, {}), /CLOSED/);
  assert.equal(existsSync(lock), false);
});
