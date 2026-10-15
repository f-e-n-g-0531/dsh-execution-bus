import { spawnSync } from "node:child_process";
export function npm(args, cwd = process.cwd()) {
  if (!process.env.npm_execpath) throw Error("Run this script through npm run");
  const r = spawnSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Error("npm " + args[0] + " failed: " + r.stderr);
  return r.stdout;
}
export function report(text) {
  const value = JSON.parse(text);
  if (!Array.isArray(value) || value.length !== 1)
    throw Error("Expected exactly one npm pack report");
  return value[0];
}
