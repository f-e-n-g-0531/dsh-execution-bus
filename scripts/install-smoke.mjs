import { spawnSync } from "node:child_process";
import path from "node:path";

/** Run only in the disposable install tree; never maintain the operator's records. */
export function runInstallSmoke(script, temp, parentEnv = process.env) {
  return spawnSync(process.execPath, [script], {
    cwd: temp,
    env: {
      ...parentEnv,
      DSH_HOME: path.join(temp, "dsh-home"),
      XIAOHE_RUNTIME_DIR: path.join(temp, "records"),
    },
    stdio: "inherit",
    timeout: 30000,
  });
}
