import { randomUUID } from "node:crypto";
import { ADMISSION_DEFAULTS, REQUEST_DESCRIPTION, REQUEST_PARAMETERS, STATE_PARAMETERS, } from "./product.js";
import { ExecutionOwner } from "./execution.js";
import { ExecutionBus, parse } from "./bus.js";
import { testHandler, readHandler } from "./handlers.js";
export const name = "execution-bus";
export const inject = ["tools", "jobs"];
export function apply(ctx) {
    const bus = new ExecutionBus(undefined, ADMISSION_DEFAULTS);
    bus.register("test", testHandler);
    bus.register("host.read", readHandler);
    const executions = new ExecutionOwner();
    ctx.effect(() => () => executions.close(() => bus.close()));
    ctx.tools.register({
        name: "execution_bus_state",
        description: "Read a bounded metadata-only snapshot of this agent session’s bus tasks. No inputs/results, no cross-session access. Do not poll during an awaited request.",
        parameters: STATE_PARAMETERS,
        output: {
            schema: {},
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
        },
        async execute(raw, exec) {
            if (executions.phase !== "open")
                throw Error("CLOSED");
            if (!exec.agent)
                throw Error("OWNING_SESSION_REQUIRED");
            if (!raw ||
                typeof raw !== "object" ||
                Array.isArray(raw) ||
                Reflect.ownKeys(raw).length)
                throw Error("INVALID_STATE_QUERY");
            return bus.inspect({
                sessionId: String(exec.agent.id),
                callId: String(exec.callId),
            });
        },
    });
    ctx.tools.register({
        name: "execution_bus",
        description: REQUEST_DESCRIPTION,
        parameters: REQUEST_PARAMETERS,
        output: {
            schema: {},
            render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
        },
        execute(raw, exec) {
            if (executions.phase !== "open")
                return Promise.reject(Error("CLOSED"));
            return executions.track(dispatch(raw, exec));
        },
    });
    async function dispatch(raw, exec) {
        if (!exec.agent)
            throw Error("OWNING_SESSION_REQUIRED");
        const owner = {
            sessionId: String(exec.agent.id),
            callId: String(exec.callId),
        }, m = parse(raw);
        if (m.type !== "request")
            return bus.command(owner, m);
        let projection;
        const attached = bus.submit(owner, m, (event) => projection?.progress(event), async (input, signal) => {
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
        let execution = executions.get(jobKey);
        if (execution)
            attached.detach(); // only the first attachment projects progress into the shared Job
        if (!execution) {
            try {
                execution = executions.create(jobKey, ctx.jobs, exec.agent.id, attached);
                projection = execution;
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
            await execution.settled;
            const value = await attached.done;
            attached.returned();
            return value;
        }
        finally {
            exec.signal.removeEventListener("abort", abort);
            attached.detach();
        }
    }
}
