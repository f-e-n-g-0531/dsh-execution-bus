import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { runNpmRelease } from "../scripts/npm-release.mjs";

const pkg = { name: "@feng0531/dsh-execution-bus", version: "1.2.3" };
const candidate = "artifacts/candidate/feng0531-dsh-execution-bus-1.2.3.tgz";
const bytes = Buffer.from("offline candidate tarball fixture");
const integrity =
  "sha512-" + createHash("sha512").update(bytes).digest("base64");
const tarball =
  "https://registry.npmjs.org/@feng0531/dsh-execution-bus/-/fixture.tgz";
const metadata = (overrides = {}) => ({
  ok: true,
  json: async () => ({ dist: { integrity, tarball, ...overrides } }),
});
const missing = { ok: false, status: 404 };
const publicBytes = (value = bytes) => ({
  ok: true,
  arrayBuffer: async () => value,
});

// Every effect is replaced; no test can upload, access the registry or wait 20s.
function fixture(responses = [], extra = {}) {
  const requests = [],
    uploads = [],
    sleeps = [],
    logs = [];
  let tick = 100;
  const deps = {
    read(path) {
      if (path === "package.json") return JSON.stringify(pkg);
      assert.equal(path, candidate);
      return bytes;
    },
    async fetch(url, options) {
      requests.push({ url: String(url), options });
      assert.ok(responses.length, "Unexpected request");
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
    spawn(...args) {
      uploads.push(args);
      return { status: 0 };
    },
    env: {
      CONFIRM_PUBLISH: "publish-execution-bus",
      NODE_AUTH_TOKEN: "fake-token",
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => tick++,
    log: (message) => logs.push(message),
    ...extra,
  };
  return { deps, requests, uploads, sleeps, logs };
}

test("publish skips upload when the same version has the candidate integrity", async () => {
  const f = fixture([metadata()]);
  await runNpmRelease("publish", f.deps);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.uploads, []);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(f.logs, ["Exact npm version exists; upload skipped"]);
});

test("publish fails closed for an existing version with different integrity", async () => {
  const f = fixture([metadata({ integrity: "sha512-different" })]);
  await assert.rejects(
    runNpmRelease("publish", f.deps),
    /Existing npm artifact differs/,
  );
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.uploads, []);
  assert.deepEqual(f.logs, []);
});

test("only a registry 404 authorizes one exact candidate upload", async () => {
  const f = fixture([missing]);
  await runNpmRelease("publish", f.deps);
  assert.deepEqual(f.uploads, [
    [
      "npm",
      [
        "publish",
        candidate,
        "--ignore-scripts",
        "--access",
        "public",
        "--registry=https://registry.npmjs.org/",
      ],
      { stdio: "inherit", timeout: 120000 },
    ],
  ]);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.sleeps, []);
});

test("CLI main guard runs for a relative script path and rejects invalid mode offline", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/npm-release.mjs", "invalid-mode"],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AssertionError/);
  assert.doesNotMatch(result.stderr, /ENOENT|fetch failed/);
});

for (const status of [401, 429, 500]) {
  test(
    "verify stops on metadata status " + status + " without retry or upload",
    async () => {
      const f = fixture([{ ok: false, status }]);
      await assert.rejects(runNpmRelease("verify", f.deps));
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.uploads, []);
      assert.deepEqual(f.sleeps, []);
      assert.deepEqual(f.logs, []);
    },
  );
  test(
    "publish stops without uploading on registry status " + status,
    async () => {
      const f = fixture([{ ok: false, status }]);
      await assert.rejects(runNpmRelease("publish", f.deps));
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.uploads, []);
    },
  );
}

for (const env of [
  {},
  { CONFIRM_PUBLISH: "publish-execution-bus" },
  { CONFIRM_PUBLISH: "wrong", NODE_AUTH_TOKEN: "fake" },
]) {
  test(
    "publish requires confirmation and token before registry access: " +
      JSON.stringify(env),
    async () => {
      const f = fixture([], { env });
      await assert.rejects(runNpmRelease("publish", f.deps));
      assert.deepEqual(f.requests, []);
      assert.deepEqual(f.uploads, []);
    },
  );
}

for (const result of [
  { status: 1 },
  { status: null },
  { error: new Error("spawn failed") },
]) {
  test(
    "failed or uncertain upload stops without automatic retry: " +
      (result.error?.message ?? result.status),
    async () => {
      const f = fixture([missing]);
      f.deps.spawn = (...args) => {
        f.uploads.push(args);
        return result;
      };
      await assert.rejects(
        runNpmRelease("publish", f.deps),
        /spawn failed|reconcile registry before retry/,
      );
      assert.equal(f.uploads.length, 1);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.sleeps, []);
    },
  );
}

test("verify retries delayed metadata and tarball 404 then checks exact bytes", async () => {
  const f = fixture([missing, metadata(), missing, metadata(), publicBytes()]);
  await runNpmRelease("verify", f.deps);
  assert.equal(f.requests.length, 5);
  const registryUrl =
    "https://registry.npmjs.org/" +
    encodeURIComponent(pkg.name) +
    "/" +
    pkg.version;
  assert.deepEqual(
    f.requests.map(({ url }) => url),
    [
      registryUrl + "?verify=100",
      registryUrl + "?verify=101",
      tarball,
      registryUrl + "?verify=102",
      tarball,
    ],
  );
  for (const { url, options } of f.requests) {
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    if (url !== tarball)
      assert.deepEqual(options.headers, { "Cache-Control": "no-cache" });
  }
  assert.deepEqual(f.sleeps, [20000, 20000]);
  assert.deepEqual(f.uploads, []);
  assert.deepEqual(f.logs, ["Public npm bytes verified"]);
});

for (const tarMissing of [false, true]) {
  test(
    "verify bounds retries for permanently missing " +
      (tarMissing ? "tarball" : "metadata"),
    async () => {
      const responses = Array.from({ length: 10 }, () =>
        tarMissing ? [metadata(), missing] : [missing],
      ).flat();
      const f = fixture(responses);
      await assert.rejects(
        runNpmRelease("verify", f.deps),
        /stop before GitHub release; do not blindly upload again/,
      );
      assert.equal(f.requests.length, tarMissing ? 20 : 10);
      assert.deepEqual(f.sleeps, Array(9).fill(20000));
      assert.deepEqual(f.uploads, []);
      assert.deepEqual(f.logs, []);
    },
  );
}

test("verify rejects different public bytes even when metadata integrity matches", async () => {
  const f = fixture([metadata(), publicBytes(Buffer.from("different bytes"))]);
  await assert.rejects(
    runNpmRelease("verify", f.deps),
    /Public npm bytes differ/,
  );
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(f.logs, []);
});

for (const dist of [
  { integrity: "sha512-different" },
  { tarball: "https://other.example/fixture.tgz" },
]) {
  test(
    "verify rejects untrusted metadata before downloading: " +
      JSON.stringify(dist),
    async () => {
      const f = fixture([metadata(dist)]);
      await assert.rejects(runNpmRelease("verify", f.deps));
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.sleeps, []);
      assert.deepEqual(f.uploads, []);
    },
  );
}

for (const mode of ["publish", "verify"]) {
  test(
    mode + " propagates registry request errors without retry or upload",
    async () => {
      const failure = new Error("offline request failed");
      const f = fixture([failure]);
      await assert.rejects(
        runNpmRelease(mode, f.deps),
        (error) => error === failure,
      );
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.uploads, []);
      assert.deepEqual(f.sleeps, []);
    },
  );
}

for (const response of [
  new Error("tarball request failed"),
  { ok: false, status: 503 },
]) {
  test(
    "verify stops on tarball failures other than 404: " +
      (response.message ?? response.status),
    async () => {
      const f = fixture([metadata(), response]);
      await assert.rejects(runNpmRelease("verify", f.deps));
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.sleeps, []);
      assert.deepEqual(f.uploads, []);
      assert.deepEqual(f.logs, []);
    },
  );
}
