import { randomUUID } from "node:crypto";
import { ExecutionBus, parse } from "./bus.js";
import { testHandler, readHandler } from "./handlers.js";
export const name = "execution-bus";
export const inject = ["tools", "jobs"];
export function apply(ctx) {
    const bus = new ExecutionBus();
    bus.register("test", testHandler);
    bus.register("host.read", readHandler);
    const sharedJobs = new Map();
    ctx.effect(() => async () => {
        await bus.close();
        await Promise.allSettled(sharedJobs.values());
        sharedJobs.clear();
    });
    ctx.tools.register({
        name: "execution_bus",
        description: "萧何 / Xiao He. Submit a version 1 request and WAIT for its terminal result in this tool call. Reuse requestId only for the same logical operation. Handlers: test {delayMs:0..30000,fail:boolean}, host.read {file_path,offset?,limit?<=100}. Control types status/result/cancel use empty payload. Acceptance is volatile, not execution success. No polling needed; no restart resume.",
        parameters: {
            type: "object",
            additionalProperties: false,
            required: [
                "protocolVersion",
                "messageId",
                "requestId",
                "type",
                "payload",
            ],
            properties: {
                protocolVersion: { type: "integer", const: 1 },
                messageId: { type: "string" },
                requestId: { type: "string" },
                type: {
                    type: "string",
                    enum: ["request", "status", "result", "cancel"],
                },
                payload: { type: "object" },
            },
        },
        output: {
            schema: {},
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
        },
        async execute(raw, exec) {
            if (!exec.agent)
                throw Error("OWNING_SESSION_REQUIRED");
            const owner = {
                sessionId: String(exec.agent.id),
                callId: String(exec.callId),
            }, m = parse(raw);
            if (m.type !== "request")
                return bus.command(owner, m);
            let handle;
            const attached = bus.submit(owner, m, (event) => handle?.updateProgress(event.type === "progress"
                ? String(event.payload.percent) + "%"
                : event.type), async (input, signal) => {
                const result = await ctx.tools.execute({
                    name: "read",
                    callId: (String(exec.callId) +
                        ":bus:" +
                        randomUUID()),
                    rootCallId: exec.rootCallId,
                    parent: exec.token,
                    agent: exec.agent,
                    arguments: input,
                    signal,
                });
                if (result.isError)
                    throw Error("HOST_READ_FAILED");
                return result.value;
            });
            // Terminal reuse is a read of an existing result, not admission of new work.
            if (attached.accepted.payload.state !== "queued" &&
                attached.accepted.payload.state !== "running") {
                try {
                    const value = await attached.done;
                    attached.returned();
                    return value;
                }
                finally {
                    attached.detach();
                }
            }
            const abort = () => attached.cancel();
            const jobKey = JSON.stringify([owner.sessionId, m.requestId]);
            let settled = sharedJobs.get(jobKey);
            if (!settled) {
                try {
                    const job = ctx.jobs.start({
                        kind: "execution-bus",
                        label: "萧何 / Xiao He",
                        owner: exec.agent.id,
                        run(h) {
                            handle = h;
                            return {
                                done: attached.done.then((v) => ({
                                    status: v.state === "succeeded"
                                        ? "completed"
                                        : v.state === "cancelled"
                                            ? "killed"
                                            : "failed",
                                    detail: v.state,
                                })),
                                cancel: abort,
                            };
                        },
                    });
                    const ownerId = exec.agent.id;
                    // One registered host waiter suppresses extra completion messages for every attachment.
                    settled = (async () => {
                        try {
                            for (;;) {
                                const view = await ctx.jobs.wait(job, 60000, ownerId);
                                if (view.status !== "running" && view.status !== "stopping")
                                    break;
                            }
                            ctx.jobs.remove(job, ownerId);
                        }
                        catch (error) {
                            // rc.2 has no typed not-found code. Match only this minted Job and
                            // confirm absence in the original owner scope; never swallow access/service errors.
                            if (!(error instanceof Error) ||
                                error.message !== `unknown job ${job}` ||
                                ctx.jobs.list(ownerId).some((view) => view.id === job))
                                throw error;
                            // Record cleanup is not execution completion. Drain the original result.
                            await attached.done;
                        }
                    })();
                    sharedJobs.set(jobKey, settled);
                    void settled.then(() => sharedJobs.delete(jobKey), () => sharedJobs.delete(jobKey));
                }
                catch {
                    abort();
                    await attached.done;
                    attached.detach();
                    throw Error("HOST_JOB_UNAVAILABLE");
                }
            }
            exec.signal.addEventListener("abort", abort, { once: true });
            if (exec.signal.aborted)
                abort();
            try {
                await settled;
                const value = await attached.done;
                attached.returned();
                return value;
            }
            finally {
                exec.signal.removeEventListener("abort", abort);
                attached.detach();
            }
        },
    });
}
