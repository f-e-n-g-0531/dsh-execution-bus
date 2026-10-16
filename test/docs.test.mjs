import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "../dist/bus.js";
import { testHandler } from "../dist/handlers.js";
function docs(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? docs(path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
    .filter((p) => p.endsWith(".md"));
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
  const readme = readFileSync("README.md", "utf8"),
    pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(readme.includes("当前版本 **" + pkg.version + "**"));
  assert.ok(readme.includes("@feng0531/dsh-execution-bus@" + pkg.version));
  const json = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) =>
    JSON.parse(m[1]),
  );
  assert.ok(json.length >= 3);
  for (const value of json)
    if (value.protocolVersion) {
      const msg = parse(value);
      if (msg.type === "request" && msg.payload.handler === "test")
        testHandler.validate(msg.payload.input);
    }
  assert.equal((readme.match(/```mermaid/g) || []).length, 2);
});
