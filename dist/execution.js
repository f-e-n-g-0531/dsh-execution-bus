import { setTimeout as pause } from "node:timers/promises";
import { Diagnostics } from "./diagnostics.js";
/** One host projection of a logical execution. The core completion remains authoritative. */
export class ExecutionHandle {
    jobs;
    owner;
    execution;
    telemetry;
    completion;
    settled;
    job;
    progressHandle;
    trace;
    constructor(jobs, owner, execution, telemetry = new Diagnostics()) {
        this.jobs = jobs;
        this.owner = owner;
        this.execution = execution;
        this.telemetry = telemetry;
        this.trace = telemetry.begin();
        this.completion = execution.done;
        const outcome = this.completion.then((v) => ({
            status: v.state === "succeeded"
                ? "completed"
                : v.state === "cancelled"
                    ? "killed"
                    : "failed",
            detail: v.state,
        }));
        this.job = jobs.start({
            kind: "execution-bus",
            label: "萧何 / Xiao He",
            owner,
            run: (handle) => {
                this.progressHandle = handle;
                return { done: outcome, cancel: () => this.requestCancel() };
            },
        });
        telemetry.record(this.trace, "job_created");
        this.settled = this.waitAndClean();
    }
    requestCancel() {
        this.execution.cancel();
    }
    progress(event) {
        this.progressHandle?.updateProgress(event.type === "progress"
            ? String(event.payload.percent) + "%"
            : event.type);
    }
    absent(error) {
        try {
            return (error instanceof Error &&
                error.message === "unknown job " + this.job &&
                !this.jobs.list(this.owner).some((v) => v.id === this.job));
        }
        catch {
            return false;
        }
    }
    async waitAndClean() {
        try {
            for (;;) {
                const view = await this.jobs.wait(this.job, 60000, this.owner);
                if (view.status !== "running" && view.status !== "stopping")
                    break;
            }
            this.jobs.remove(this.job, this.owner);
            this.telemetry.record(this.trace, "job_released");
        }
        catch (error) {
            this.telemetry.record(this.trace, "job_error");
            const removed = this.absent(error);
            // Retain the original execution, including while its caller/owner is being disposed.
            await this.completion;
            if (removed)
                this.telemetry.record(this.trace, "job_released");
            if (!removed) {
                for (let attempt = 0; attempt < 20; attempt++) {
                    try {
                        const view = this.jobs
                            .list(this.owner)
                            .find((v) => v.id === this.job && v.owner === this.owner);
                        if (!view) {
                            this.telemetry.record(this.trace, "job_released");
                            break;
                        }
                        if (view.status !== "running" && view.status !== "stopping") {
                            this.jobs.remove(this.job, this.owner);
                            this.telemetry.record(this.trace, "job_released");
                            break;
                        }
                    }
                    catch {
                        break;
                    }
                    await pause(10);
                }
                throw error;
            }
        }
        finally {
            this.progressHandle = undefined;
        }
    }
}
/** Owns host projections and active deliveries, not a second execution state machine. */
export class ExecutionOwner {
    handles = new Map();
    deliveries = new Set();
    closing;
    telemetry = new Diagnostics();
    create(key, jobs, owner, execution) {
        if (this.phase !== "open")
            throw Error("CLOSED");
        if (this.handles.has(key))
            throw Error("DUPLICATE_EXECUTION_HANDLE");
        const handle = new ExecutionHandle(jobs, owner, execution, this.telemetry);
        this.add(key, handle);
        return handle;
    }
    diagnostics() {
        return {
            ...this.telemetry.snapshot(),
            phase: this.phase,
            activeProjections: this.handles.size,
            deliveries: this.deliveries.size,
        };
    }
    currentPhase = "open";
    get phase() {
        return this.currentPhase;
    }
    get(key) {
        return this.handles.get(key);
    }
    add(key, handle) {
        if (this.phase !== "open")
            throw Error("CLOSED");
        if (this.handles.has(key))
            throw Error("DUPLICATE_EXECUTION_HANDLE");
        this.handles.set(key, handle);
        const release = () => {
            if (this.handles.get(key) === handle)
                this.handles.delete(key);
        };
        void handle.settled.then(release, release);
    }
    track(delivery) {
        this.deliveries.add(delivery);
        const release = () => this.deliveries.delete(delivery);
        void delivery.then(release, release);
        return delivery;
    }
    close(drainCore) {
        if (this.closing)
            return this.closing;
        this.currentPhase = "stopping";
        let resolve, reject;
        this.closing = new Promise((r, j) => {
            resolve = r;
            reject = j;
        });
        void (async () => {
            const core = drainCore();
            this.currentPhase = "draining";
            await core;
            await Promise.allSettled([...this.deliveries]);
            this.currentPhase = "releasing";
            await Promise.allSettled([...this.handles.values()].map((h) => h.settled));
            this.handles.clear();
            this.currentPhase = "closed";
        })().then(resolve, reject);
        return this.closing;
    }
}
