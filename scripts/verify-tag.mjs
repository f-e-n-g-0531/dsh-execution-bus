import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
export function verifyTag(tag, p, lock) {
  assert.match(
    tag ?? "",
    /^v(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/,
  );
  assert.equal(tag, "v" + p.version);
  assert.equal(lock.version, p.version);
  assert.equal(lock.packages[""].version, p.version);
  assert.equal(lock.name, p.name);
}
if (process.argv[1]?.endsWith("verify-tag.mjs")) {
  verifyTag(
    process.env.RELEASE_TAG ?? process.env.GITHUB_REF_NAME,
    JSON.parse(readFileSync("package.json")),
    JSON.parse(readFileSync("package-lock.json")),
  );
  console.log("Version tag and lock verified");
}
