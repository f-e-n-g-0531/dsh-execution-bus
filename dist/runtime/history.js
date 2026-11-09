import { randomUUID } from "node:crypto";
import { ERRORS } from "../error-codes.js";
/** Bounded process-local membership snapshots, not frozen run states or authorization. */
export class HistoryPages {
    snapshots = new Map();
    page(owner, task, input, capture) {
        const limit = input.limit === undefined ? 20 : input.limit;
        if (typeof limit !== "number" ||
            !Number.isInteger(limit) ||
            limit < 1 ||
            limit > 100)
            throw Error(ERRORS.INVALID_PLAN);
        const now = Date.now();
        for (const [key, value] of this.snapshots)
            if (now - value.at >= 300_000)
                this.snapshots.delete(key);
        let key, offset = 0;
        if (input.cursor !== undefined) {
            if (input.snapshot !== undefined ||
                typeof input.cursor !== "string" ||
                !/^[0-9a-f-]{36}:[0-9]{1,4}$/.test(input.cursor))
                throw Error(ERRORS.INVALID_PLAN);
            const parts = input.cursor.split(":");
            key = parts[0];
            offset = Number(parts[1]);
        }
        else {
            if (input.snapshot !== true)
                throw Error(ERRORS.INVALID_PLAN);
            const ids = capture();
            if (ids.length > 1000)
                throw Error(ERRORS.RUNTIME_INVALID_STATE);
            key = randomUUID();
            while (this.snapshots.size >= 16)
                this.snapshots.delete(this.snapshots.keys().next().value);
            this.snapshots.set(key, { owner, task, ids, at: now });
        }
        const saved = this.snapshots.get(key);
        if (!saved || saved.owner !== owner || saved.task !== task)
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        if (offset > saved.ids.length)
            throw Error(ERRORS.INVALID_PLAN);
        const end = Math.min(offset + limit, saved.ids.length);
        return {
            ids: saved.ids.slice(offset, end),
            offset,
            limit,
            hasMore: end < saved.ids.length,
            pagination: {
                mode: "snapshot",
                capturedAt: saved.at,
                expiresAt: saved.at + 300_000,
                total: saved.ids.length,
                missingRunIds: [],
                ...(end < saved.ids.length ? { nextCursor: key + ":" + end } : {}),
            },
        };
    }
    clear() {
        this.snapshots.clear();
    }
}
