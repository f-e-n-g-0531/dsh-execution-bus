import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import path from "node:path";
import { ERRORS } from "../error-codes.js";
const RECORD_BYTES = 32 * 1024;
const TEXT_BYTES = 4096;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = new Set([
    "runId",
    "key",
    "revision",
    "status",
    "attempts",
    "attemptToken",
    "updatedAt",
]);
const text = (value) => typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= TEXT_BYTES &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    Buffer.from(value, "utf8").toString("utf8") === value;
const integer = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function valid(value, runId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const r = value;
    if (Object.keys(r).some((key) => !FIELDS.has(key)) ||
        r.runId !== runId ||
        !text(r.runId) ||
        !text(r.key) ||
        !integer(r.revision) ||
        r.revision < 1 ||
        !integer(r.attempts) ||
        r.attempts >= r.revision ||
        !integer(r.updatedAt))
        return false;
    if (r.status === "delivering")
        return (r.attempts > 0 &&
            typeof r.attemptToken === "string" &&
            TOKEN.test(r.attemptToken));
    if (Object.hasOwn(r, "attemptToken"))
        return false;
    if (r.status === "pending")
        return r.attempts === 0;
    if (r.status === "sent" || r.status === "failed")
        return r.attempts > 0;
    return r.status === "withdrawn";
}
function next(value) {
    if (value >= Number.MAX_SAFE_INTEGER)
        throw Error(ERRORS.RUNTIME_INVALID_STATE);
    return value + 1;
}
/** Durable receipts only. No sending, polling, retrying or DAG execution.
 * The host owns this private directory. Locks left by a crash are deliberately
 * not stolen: the host must reconcile them explicitly while writers are stopped.
 * A delivering receipt is never automatically retried, including after restart.
 */
export class NotificationStore {
    directory;
    constructor(directory) {
        if (typeof directory !== "string" || !directory || directory.includes("\0"))
            throw Error(ERRORS.INVALID_PLAN);
        try {
            this.directory = path.resolve(directory);
            mkdirSync(this.directory, { recursive: true });
        }
        catch {
            throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
        }
    }
    sync(owner, runId, key, shouldNotify) {
        const target = this.target(owner, runId);
        if (!text(key) || typeof shouldNotify !== "boolean")
            throw Error(ERRORS.INVALID_PLAN);
        return this.locked(target, () => {
            const current = this.read(target, runId);
            if (!shouldNotify) {
                if (!current ||
                    current.status === "sent" ||
                    current.status === "withdrawn")
                    return current;
                const { attemptToken: _token, ...rest } = current;
                return this.save(target, {
                    ...rest,
                    revision: next(current.revision),
                    status: "withdrawn",
                    updatedAt: Date.now(),
                });
            }
            if (current?.key === key)
                return current;
            return this.save(target, {
                runId,
                key,
                revision: current ? next(current.revision) : 1,
                status: "pending",
                attempts: 0,
                updatedAt: Date.now(),
            });
        });
    }
    get(owner, runId) {
        return this.read(this.target(owner, runId), runId);
    }
    claim(owner, runId, key, expectedRevision) {
        const target = this.target(owner, runId);
        this.checkExpected(key, expectedRevision);
        return this.locked(target, () => {
            const current = this.expected(target, runId, key, expectedRevision);
            if (current.status !== "pending" && current.status !== "failed")
                throw Error(ERRORS.RUNTIME_INVALID_STATE);
            return this.save(target, {
                ...current,
                revision: next(current.revision),
                status: "delivering",
                attempts: next(current.attempts),
                attemptToken: randomUUID(),
                updatedAt: Date.now(),
            });
        });
    }
    settle(owner, runId, key, expectedRevision, attemptToken, outcome) {
        const target = this.target(owner, runId);
        this.checkExpected(key, expectedRevision);
        if (typeof attemptToken !== "string" ||
            !TOKEN.test(attemptToken) ||
            (outcome !== "sent" && outcome !== "failed"))
            throw Error(ERRORS.INVALID_PLAN);
        return this.locked(target, () => {
            const current = this.expected(target, runId, key, expectedRevision);
            if (current.status !== "delivering")
                throw Error(ERRORS.RUNTIME_INVALID_STATE);
            if (current.attemptToken !== attemptToken)
                throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
            const { attemptToken: _token, ...rest } = current;
            return this.save(target, {
                ...rest,
                revision: next(current.revision),
                status: outcome,
                updatedAt: Date.now(),
            });
        });
    }
    target(owner, runId) {
        if (!text(owner) || !text(runId))
            throw Error(ERRORS.INVALID_PLAN);
        // A JSON tuple is unambiguous even when either identifier contains separators.
        const name = createHash("sha256")
            .update(JSON.stringify([owner, runId]))
            .digest("hex");
        return path.join(this.directory, name + ".json");
    }
    checkExpected(key, revision) {
        if (!text(key) || !integer(revision) || revision < 1)
            throw Error(ERRORS.INVALID_PLAN);
    }
    expected(target, runId, key, revision) {
        const current = this.read(target, runId);
        if (!current)
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        if (current.key !== key || current.revision !== revision)
            throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
        return current;
    }
    locked(target, action) {
        const lock = target + ".lock";
        let fd;
        try {
            fd = openSync(lock, "wx", 0o600);
        }
        catch (error) {
            if (error.code === "EEXIST")
                throw Error(ERRORS.RUNTIME_BUSY);
            throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
        }
        try {
            return action();
        }
        finally {
            try {
                closeSync(fd);
                rmSync(lock);
            }
            catch {
                // No raw filesystem causes: errors must not disclose owner, token or paths.
                throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
            }
        }
    }
    read(target, runId) {
        let fd;
        try {
            const link = lstatSync(target);
            if (!link.isFile() || link.isSymbolicLink())
                throw Error();
            fd = openSync(target, "r");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return undefined;
            throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
        }
        try {
            const before = fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.size > BigInt(RECORD_BYTES))
                throw Error();
            const bytes = Buffer.alloc(Number(before.size) + 1);
            let length = 0;
            while (length < bytes.length) {
                const count = readSync(fd, bytes, length, bytes.length - length, null);
                if (count === 0)
                    break;
                length += count;
            }
            const after = fstatSync(fd, { bigint: true });
            if (length !== Number(before.size) ||
                length > RECORD_BYTES ||
                before.size !== after.size ||
                before.mtimeNs !== after.mtimeNs ||
                before.ctimeNs !== after.ctimeNs)
                throw Error();
            const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
            const value = JSON.parse(json);
            if (!valid(value, runId))
                throw Error();
            return value;
        }
        catch {
            // Corruption is not absence: never overwrite an unreadable receipt.
            throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
        }
        finally {
            try {
                closeSync(fd);
            }
            catch {
                throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
            }
        }
    }
    save(target, receipt) {
        const temp = target + "." + randomUUID() + ".tmp";
        let fd;
        let created = false;
        try {
            const json = JSON.stringify(receipt);
            if (!valid(receipt, receipt.runId) ||
                Buffer.byteLength(json) > RECORD_BYTES)
                throw Error();
            fd = openSync(temp, "wx", 0o600);
            created = true;
            writeFileSync(fd, json, "utf8");
            fsyncSync(fd);
            closeSync(fd);
            fd = undefined;
            renameSync(temp, target);
            created = false;
            return receipt;
        }
        catch {
            throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
        }
        finally {
            if (fd !== undefined) {
                try {
                    closeSync(fd);
                }
                catch {
                    /* preserve failure */
                }
            }
            if (created) {
                try {
                    rmSync(temp, { force: true });
                }
                catch {
                    /* best effort */
                }
            }
        }
    }
}
