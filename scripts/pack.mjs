import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { npm, report } from "./npm.mjs";
const dir = path.resolve("artifacts/candidate");
mkdirSync(dir, { recursive: true });
const r = report(
  npm(["pack", "--ignore-scripts", "--json", "--pack-destination", dir]),
);
const bytes = readFileSync(path.join(dir, r.filename));
writeFileSync(
  path.join(dir, "SHA256SUMS.txt"),
  createHash("sha256").update(bytes).digest("hex") + "  " + r.filename + "\n",
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, "filename=" + r.filename + "\n");
console.log(r.filename);
