import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { verifyTag } from "./verify-tag.mjs";
const p = JSON.parse(readFileSync("package.json")),
  lock = JSON.parse(readFileSync("package-lock.json"));
verifyTag(process.env.RELEASE_TAG, p, lock);
assert.equal(
  process.env.CONFIRM_PUBLISH,
  "publish-execution-bus",
  "Explicit publication confirmation required",
);
assert.ok(
  p.license && p.license !== "UNLICENSED",
  "License not decided: stop publication",
);
assert.ok(existsSync("LICENSE"), "Missing reviewed LICENSE");
assert.ok(readFileSync("LICENSE", "utf8").trim(), "Empty LICENSE");
assert.ok(
  readFileSync("docs/releases/" + p.version + ".md", "utf8").trim(),
  "Version release notes missing",
);
console.log("Release preflight passed");
