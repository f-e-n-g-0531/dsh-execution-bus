import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ERRORS } from "../error-codes.js";
const RUN_ID = /^run-[0-9a-z-]{8,80}$/;
const RECORD_BYTES = 4 * 1024 * 1024;
export function defaultRunRoot() {
    if (process.env.XIAOHE_RUNTIME_DIR)
        return path.resolve(process.env.XIAOHE_RUNTIME_DIR);
    const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
    return path.join(home, "tmp", "xiaohe-runtime", "runs");
}
/** 纯文件持久化运行记录；原子写入，损坏记录忽略，不做跨进程锁。 */
export class RunStore {
    root;
    constructor(root = defaultRunRoot()) {
        this.root = root;
        mkdirSync(this.root, { recursive: true });
    }
    pathFor(runId) {
        if (!RUN_ID.test(runId))
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        return path.join(this.root, runId + ".json");
    }
    save(run) {
        const target = this.pathFor(run.runId);
        const json = JSON.stringify(run);
        if (Buffer.byteLength(json) > RECORD_BYTES)
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        const temp = target + ".tmp";
        writeFileSync(temp, json, "utf8");
        renameSync(temp, target);
    }
    load(runId) {
        let text;
        try {
            text = readFileSync(this.pathFor(runId), "utf8");
        }
        catch {
            return undefined;
        }
        try {
            const value = JSON.parse(text);
            if (value?.version !== 1 || value.runId !== runId)
                return undefined;
            if (!Array.isArray(value.steps) || typeof value.plan !== "object")
                return undefined;
            return value;
        }
        catch {
            return undefined;
        }
    }
    list(limit = 20) {
        let names = [];
        try {
            names = readdirSync(this.root);
        }
        catch {
            return [];
        }
        const runs = [];
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const run = this.load(name.slice(0, -".json".length));
            if (run)
                runs.push(run);
        }
        runs.sort((a, b) => b.updatedAt - a.updatedAt);
        return runs.slice(0, limit);
    }
    remove(runId) {
        rmSync(this.pathFor(runId), { force: true });
    }
    prune(max = 100) {
        for (const run of this.list(10000).slice(max))
            this.remove(run.runId);
    }
    /** 启动时把上次进程留下的 running 记录标记为 interrupted；不自动重跑副作用步骤。 */
    markInterrupted() {
        let count = 0;
        for (const run of this.list(1000)) {
            if (run.state !== "running")
                continue;
            run.state = "interrupted";
            run.error = ERRORS.RUNTIME_INTERRUPTED;
            run.finishedAt ??= Date.now();
            for (const step of run.steps) {
                if (step.state === "running") {
                    step.state = "unknown";
                    step.error = ERRORS.RUNTIME_INTERRUPTED;
                    step.finishedAt ??= Date.now();
                }
            }
            run.updatedAt = Date.now();
            this.save(run);
            count++;
        }
        return count;
    }
}
