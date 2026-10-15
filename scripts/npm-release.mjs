import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const mode = process.argv[2];
assert.ok(["publish", "verify"].includes(mode));
const p = JSON.parse(readFileSync("package.json"));
assert.equal(p.name, "@feng0531/dsh-execution-bus");
const bytes = readFileSync(
    "artifacts/candidate/feng0531-dsh-execution-bus-" + p.version + ".tgz",
  ),
  integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
const url =
  "https://registry.npmjs.org/" + encodeURIComponent(p.name) + "/" + p.version;
const get = () =>
  fetch(url + "?verify=" + Date.now(), {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
    headers: { "Cache-Control": "no-cache" },
  });
if (mode === "publish") {
  assert.equal(process.env.CONFIRM_PUBLISH, "publish-execution-bus");
  assert.ok(process.env.NODE_AUTH_TOKEN, "Missing npm automation token");
  const response = await get();
  if (response.ok) {
    assert.equal(
      (await response.json()).dist.integrity,
      integrity,
      "Existing npm artifact differs",
    );
    console.log("Exact npm version exists; upload skipped");
  } else {
    assert.equal(response.status, 404);
    const result = spawnSync(
      "npm",
      [
        "publish",
        "artifacts/candidate/feng0531-dsh-execution-bus-" + p.version + ".tgz",
        "--ignore-scripts",
        "--access",
        "public",
        "--registry=https://registry.npmjs.org/",
      ],
      { stdio: "inherit", timeout: 120000 },
    );
    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      "Upload failed; reconcile registry before retry",
    );
  }
} else {
  let verified = false;
  for (let i = 0; i < 10; i++) {
    const response = await get();
    if (response.ok) {
      const meta = await response.json();
      assert.equal(meta.dist.integrity, integrity);
      const tar = new URL(meta.dist.tarball);
      assert.equal(tar.origin, "https://registry.npmjs.org");
      const r = await fetch(tar, {
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      if (r.ok) {
        assert.ok(
          bytes.equals(Buffer.from(await r.arrayBuffer())),
          "Public npm bytes differ",
        );
        verified = true;
        break;
      }
      assert.equal(r.status, 404);
    } else assert.equal(response.status, 404);
    if (i < 9) await new Promise((r) => setTimeout(r, 20000));
  }
  assert.ok(
    verified,
    "Public npm artifact unverified: stop before GitHub release; do not blindly upload again",
  );
  console.log("Public npm bytes verified");
}
