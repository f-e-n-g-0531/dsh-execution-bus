import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { PRODUCT } from "../dist/product.js";

test("plugin list displays the product name through exported locale metadata", async () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(PRODUCT.name, "萧何 / Xiao He");
  // DSH resolves <package>/locale/en.json through package exports, then reads that directory.
  assert.equal(pkg.exports["./locale/*.json"], "./locale/*.json");
  assert.equal(pkg.exports["./package.json"], "./package.json");
  assert.ok(pkg.files.includes("locale"));
  const en = (await import("@feng0531/dsh-execution-bus/locale/en.json", {
    with: { type: "json" },
  })).default.meta;
  const zh = JSON.parse(readFileSync("locale/zh.json", "utf8")).meta;
  assert.equal(en.title, PRODUCT.name);
  assert.equal(zh.title, PRODUCT.name);
  assert.match(en.description, /DAG/);
  assert.match(zh.description, /DAG/);
  for (const meta of [en, zh]) assert.ok(meta.description.length < 160);
  // Host active locale id is "zh"; a zh-CN filename would not be selected.
  assert.ok(!existsSync("locale/zh-CN.json"));
  // Display metadata never renames the install or runtime identity.
  assert.equal(pkg.name, PRODUCT.packageName);
});
