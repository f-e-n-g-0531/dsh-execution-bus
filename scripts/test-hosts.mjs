import { mkdtemp, rm, cp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { npm } from "./npm.mjs";

const ROOT = process.cwd();
const DEFAULT = ["0.2.0-rc.1", "0.2.1-rc.5", "0.2.2-alpha.2", "0.2.2-rc.1", "0.2.2-rc.3"];
const ALL = JSON.parse((await readFile(path.join(ROOT, "artifacts/dsh-versions.json"), "utf8")).replace(/^\uFEFF/, ""));
const versions = process.argv.includes("--all") ? ALL : DEFAULT;
const report = { generatedAt: new Date().toISOString(), requested: versions, results: [] };

function hostPeers(version) {
  const modern = version.startsWith("0.2.2-");
  const cordis = modern ? "4.1.0" : "4.0.4";
  const include = modern ? "1.1.0" : "1.0.0";
  const names = ["dsh-agent-preset-registry", "dsh-agent", "dsh-llm", "dsh-session", "dsh-sandbox-policy", "dsh-user-approval", "dsh-working-directory", "dsh-scope", "dsh-system-prompt", "dsh-tools"];
  return { "@deepseek-ai/cordis": cordis, "@deepseek-ai/cordis-plugin-include": include, ...Object.fromEntries(names.map(n => ["@deepseek-ai/" + n, version])) };
}
function run(command, args, cwd) { return spawnSync(command, args, { cwd, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }); }

await mkdir(path.join(ROOT, "artifacts"), { recursive: true });
for (const version of versions) {
  const row = { version, status: "failed", stdout: "", stderr: "", checks: [] };
  let temp;
  try {
    temp = await mkdtemp(path.join(tmpdir(), "dsh-host-compat-"));
    await writeFile(path.join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }));
    const peers = hostPeers(version);
    // Let npm resolve Cordis/include against each host release declared peer ranges; no force flags.
    const specs = Object.entries(peers).filter(([name]) => name !== "@deepseek-ai/cordis" && name !== "@deepseek-ai/cordis-plugin-include").map(([name, v]) => name + "@" + v);
    const install = run(process.execPath, [process.env.npm_execpath, "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", ...specs], temp);
    row.stdout += install.stdout ?? ""; row.stderr += install.stderr ?? "";
    if (install.status !== 0) throw Error("peer install failed (no force/legacy-peer-deps used)");
    const plugin = path.join(temp, "node_modules/@feng0531/dsh-execution-bus");
    await mkdir(plugin, { recursive: true });
    await cp(path.join(ROOT, "dist"), path.join(plugin, "dist"), { recursive: true });
    for (const item of ["locale", "cordis.patch.yml", "package.json"]) await cp(path.join(ROOT, item), path.join(plugin, item), { recursive: true });
    await cp(path.join(ROOT, "test/fixtures/host-compat-smoke.mjs"), path.join(temp, "smoke.mjs"));
    const child = run(process.execPath, ["smoke.mjs", version], temp);
    row.stdout += child.stdout ?? ""; row.stderr += child.stderr ?? "";
    if (child.status !== 0) throw Error("smoke exited " + child.status);
    const parsed = (child.stdout ?? "").trim().split("\n").map(x => { try { return JSON.parse(x); } catch { return null; } }).find(Boolean);
    row.checks = parsed?.checks ?? [];
    row.status = parsed?.status === "passed" ? "passed" : "failed";
    if (row.status !== "passed") throw Error("smoke reported failure");
  } catch (error) { row.error = String(error?.stack ?? error); }
  finally { if (temp) await rm(temp, { recursive: true, force: true }); }
  report.results.push(row);
  console.log(JSON.stringify(row));
}
await writeFile(path.join(ROOT, "artifacts/host-compatibility-results.json"), JSON.stringify(report, null, 2) + "\n");
if (report.results.some(r => r.status !== "passed")) process.exitCode = 1;
