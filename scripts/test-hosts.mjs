import { mkdtemp, rm, cp, readFile, writeFile, mkdir, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT = ["0.2.0-rc.1", "0.2.1-rc.5", "0.2.2-alpha.2", "0.2.2-rc.1", "0.2.2-rc.3"];
const HOST_NAMES = ["dsh-agent-preset-registry", "dsh-agent", "dsh-llm", "dsh-session", "dsh-sandbox-policy", "dsh-user-approval", "dsh-working-directory", "dsh-scope", "dsh-system-prompt", "dsh-tools"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const json = bytes => JSON.parse(String(bytes).replace(/^\uFEFF/, ""));

// Hash relative paths as well as bytes; a rename/removal must change identity.
export async function fingerprint(root, items) {
  const files = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw Error("Fingerprint refuses symlink: " + relative);
    if (stat.isFile()) { files.push({ path: relative.replaceAll("\\", "/"), sha256: sha256(await readFile(absolute)) }); return; }
    if (!stat.isDirectory()) throw Error("Fingerprint refuses non-regular entry: " + relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      if (entry.isSymbolicLink()) throw Error("Fingerprint refuses symlink: " + entry.name);
      await visit(path.join(relative, entry.name));
    }
  }
  for (const item of items) await visit(item);
  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { algorithm: "sha256", digest: sha256(JSON.stringify(files)), files };
}

export async function candidateIdentity(root) {
  const manifest = json(await readFile(path.join(root, "package.json")));
  return {
    name: manifest.name, version: manifest.version,
    source: await fingerprint(root, ["src", "package.json", "tsconfig.json"]),
    dist: await fingerprint(root, ["dist"]),
    package: await fingerprint(root, ["dist", "locale", "cordis.patch.yml", "package.json"]),
    harness: await fingerprint(root, ["test/fixtures/host-compat-smoke.mjs", "scripts/test-hosts.mjs"]),
    sourceDistCorrespondence: "not_verified_no_build_performed",
  };
}

export function executionStatus(install, child, smoke) {
  if (!install) return "not_executed";
  if (install.error || install.status !== 0) return "installation_failed";
  if (!child) return "not_executed";
  if (child.error || child.status !== 0 || smoke?.status !== "passed") return "execution_failed";
  return "passed";
}

function run(command, args, cwd, runtimeRoot) {
  return spawnSync(command, args, { cwd, env: { ...process.env, XIAOHE_RUNTIME_DIR: runtimeRoot }, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
}
function processEvidence(result) {
  return { exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : undefined };
}
async function hostIdentity(temp) {
  const lockBytes = await readFile(path.join(temp, "package-lock.json"));
  const lock = json(lockBytes), packages = {};
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location.includes("node_modules/@deepseek-ai/")) continue;
    const bytes = await readFile(path.join(temp, location, "package.json"));
    const manifest = json(bytes);
    packages[location] = { name: manifest.name, version: manifest.version, resolved: entry.resolved, integrity: entry.integrity, manifestSha256: sha256(bytes) };
  }
  return { node: process.version, platform: process.platform, arch: process.arch, lockSha256: sha256(lockBytes), packages };
}

export async function main(args = process.argv.slice(2), root = process.cwd()) {
  for (const arg of args) if (!["--all", "--no-execute"].includes(arg)) throw Error("Unknown host matrix argument: " + arg);
  const all = args.includes("--all") ? json(await readFile(path.join(root, "artifacts/dsh-versions.json"))) : DEFAULT;
  const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), requested: all, candidate: await candidateIdentity(root), results: [] };
  const output = path.join(root, "artifacts/host-compatibility-results.json");
  await mkdir(path.dirname(output), { recursive: true });
  for (const version of all) {
    const row = { version, status: "not_executed", installation: { status: "not_executed" }, execution: { status: "not_executed" }, stdout: "", stderr: "", checks: [] };
    let temp, phase = "preparation";
    try {
      if (args.includes("--no-execute")) { row.reason = "explicit_no_execute"; continue; }
      if (!process.env.npm_execpath) throw Error("Run this script through npm run (npm_execpath required)");
      temp = await mkdtemp(path.join(tmpdir(), "dsh-host-compat-"));
      await writeFile(path.join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
      // Resolve each host release's declared peers; never force or use legacy-peer-deps.
      const specs = HOST_NAMES.map(name => "@deepseek-ai/" + name + "@" + version);
      row.installation.command = [process.execPath, process.env.npm_execpath, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", ...specs];
      phase = "installation";
      const install = run(process.execPath, row.installation.command.slice(1), temp, path.join(temp, "runtime-records"));
      row.stdout += install.stdout ?? ""; row.stderr += install.stderr ?? "";
      row.installation = { ...row.installation, ...processEvidence(install), status: install.status === 0 && !install.error ? "passed" : "failed" };
      row.status = executionStatus(install);
      if (row.status === "installation_failed") throw Error("peer install failed (no force/legacy-peer-deps used)");
      phase = "execution";
      row.host = await hostIdentity(temp);
      for (const name of HOST_NAMES) {
        const actual = row.host.packages["node_modules/@deepseek-ai/" + name];
        if (actual?.version !== version) throw Error("Exact host version mismatch: " + name);
      }
      const plugin = path.join(temp, "node_modules/@feng0531/dsh-execution-bus");
      await mkdir(plugin, { recursive: true });
      for (const item of ["dist", "locale", "cordis.patch.yml", "package.json"]) await cp(path.join(root, item), path.join(plugin, item), { recursive: true });
      row.copiedPackage = await fingerprint(plugin, ["dist", "locale", "cordis.patch.yml", "package.json"]);
      if (row.copiedPackage.digest !== report.candidate.package.digest) throw Error("Copied candidate fingerprint mismatch");
      await cp(path.join(root, "test/fixtures/host-compat-smoke.mjs"), path.join(temp, "smoke.mjs"));
      const child = run(process.execPath, ["smoke.mjs", version], temp, path.join(temp, "runtime-records"));
      row.stdout += child.stdout ?? ""; row.stderr += child.stderr ?? "";
      const smoke = (child.stdout ?? "").trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.version === version && Array.isArray(value.checks));
      row.execution = { status: "failed", ...processEvidence(child), smoke: smoke ?? null };
      row.checks = smoke?.checks ?? [];
      row.status = executionStatus(install, child, smoke);
      if (row.status === "passed") {
        for (const [name, actual] of Object.entries(smoke.host ?? {})) {
          const installed = row.host.packages["node_modules/" + name];
          if (!installed || actual.version !== installed.version || actual.manifestSha256 !== installed.manifestSha256) throw Error("Executed host identity mismatch: " + name);
        }
        if (Object.keys(smoke.host ?? {}).length < 5) throw Error("Missing executed host identity");
        row.execution.status = "passed";
      }
    } catch (error) {
      row.status = phase === "preparation" ? "not_executed" : phase === "installation" ? "installation_failed" : "execution_failed";
      if (phase !== "preparation") row[phase].status = "failed";
      row.error = String(error?.stack ?? error);
    } finally {
      if (temp) { try { await rm(temp, { recursive: true, force: true }); } catch (error) { row.cleanupError = String(error); row.status = "execution_failed"; } }
      report.results.push(row);
      console.log(JSON.stringify(row));
      // Save after every row, so interruption does not erase earlier evidence.
      await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
  }
  const finalCandidate = await candidateIdentity(root);
  report.candidateUnchanged = JSON.stringify(finalCandidate) === JSON.stringify(report.candidate);
  if (!report.candidateUnchanged) {
    report.finalCandidate = finalCandidate;
    for (const row of report.results) if (row.status === "passed") { row.status = "execution_failed"; row.error = "Candidate changed during matrix execution"; }
  }
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  if (!report.candidateUnchanged || report.results.some(row => row.status !== "passed")) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
