import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", timeout: 120000 });
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const repo = process.env.GH_REPO,
  tag = process.env.RELEASE_TAG;
const runs = JSON.parse(
  gh([
    "api",
    "repos/" +
      repo +
      "/actions/workflows/ci.yml/runs?head_sha=" +
      sha +
      "&event=push&per_page=100",
  ]),
)
  .workflow_runs.filter((r) => r.head_sha === sha && r.head_branch === tag)
  .sort((a, b) => b.id - a.id);
assert.ok(runs.length, "Exact tag push CI required");
assert.equal(runs[0].conclusion, "success");
const dir = "artifacts/tag-ci";
mkdirSync(dir, { recursive: true });
gh(["run", "download", String(runs[0].id), "--repo", repo, "--dir", dir]);
const expected = [
  "execution-bus-ubuntu-latest-node-22",
  "execution-bus-ubuntu-latest-node-24",
  "execution-bus-windows-latest-node-22",
  "execution-bus-windows-latest-node-24",
];
const pkg = JSON.parse(readFileSync("package.json"));
const filename = "feng0531-dsh-execution-bus-" + pkg.version + ".tgz";
const local = readFileSync(path.join("artifacts/candidate", filename));
for (const name of expected) {
  assert.ok(
    readdirSync(dir).includes(name),
    "Missing matrix artifact: " + name,
  );
  assert.ok(
    local.equals(readFileSync(path.join(dir, name, filename))),
    "Candidate differs: " + name,
  );
}
console.log("Exact tag CI and four candidate bytes verified");
