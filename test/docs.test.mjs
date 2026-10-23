import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parsePlan } from "../dist/runtime/plan.js";

function docs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? docs(path.join(dir, entry.name))
        : [path.join(dir, entry.name)],
    )
    .filter((file) => file.endsWith(".md"));
}

test("public documentation has resolvable local links and current README examples", () => {
  for (const file of ["README.md", "THIRD_PARTY_NOTICES.md", ...docs("docs")]) {
    const text = readFileSync(file, "utf8");
    assert.ok(
      !text.includes("../dev/host-snapshot/"),
      file + " contains unshipped evidence link",
    );
    for (const match of text.matchAll(/][(](?:<([^>]+)>|([^\s)]+))[)]/g)) {
      const target = match[1] ?? match[2];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      assert.ok(
        existsSync(
          path.resolve(
            path.dirname(file),
            decodeURIComponent(target.split("#")[0]),
          ),
        ),
        file + " broken link: " + target,
      );
    }
  }
  const readme = readFileSync("README.md", "utf8");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(readme.includes("当前版本 **" + pkg.version + "**"));
  assert.ok(readme.includes("@feng0531/dsh-execution-bus@" + pkg.version));
  for (const file of ["README.md", "docs/DECLARATIVE-RUNTIME.md"]) {
    const text = readFileSync(file, "utf8");
    const json = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((match) =>
      JSON.parse(match[1]),
    );
    assert.ok(json.length >= 1, file + " has no plan example");
    for (const value of json)
      if (
        value &&
        typeof value === "object" &&
        Array.isArray(value.steps) &&
        !value.protocolVersion
      )
        parsePlan(value);
  }
});

test("current runtime docs keep migration and acceptance boundaries explicit", () => {
  const runtime = readFileSync("docs/DECLARATIVE-RUNTIME.md", "utf8");
  assert.doesNotMatch(runtime, /迁移中|暂保留为兼容|两者当前共存/);
  for (const token of [
    "exactly-once",
    "RUNTIME_INTERRUPTED",
    "RUNTIME_BACKGROUND_UNSUPPORTED",
    "job_output/job_kill",
  ])
    assert.ok(
      runtime.includes(token),
      "missing runtime safety boundary: " + token,
    );
  const validation = readFileSync("docs/validation.md", "utf8");
  assert.doesNotMatch(validation, /全量\s*\*\*\d+\*\*\s*项测试通过/);
  assert.match(validation, /npm run check/);
  assert.match(validation, /shell bridge[^\n]*不是实际 sandbox/);
  assert.match(validation, /真实模型\/桌面 UI\/实际沙箱[^\n]*未验收/);
});
