import { randomUUID } from "node:crypto";
import { ADMISSION_DEFAULTS, REQUEST_DESCRIPTION, REQUEST_PARAMETERS, STATE_PARAMETERS, } from "./product.js";
import { ExecutionOwner } from "./execution.js";
import { ExecutionBus, parse } from "./bus.js";
import { ERRORS } from "./error-codes.js";
import { testHandler, readHandler, editHandler, writeHandler, } from "./handlers.js";
export const name = "execution-bus";
export const inject = ["tools", "jobs"];
export function apply(ctx) {
    const bus = new ExecutionBus(undefined, ADMISSION_DEFAULTS);
    bus.register("test", testHandler);
    bus.register("host.read", readHandler);
    bus.register("host.edit", editHandler);
    bus.register("host.write", writeHandler);
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
                throw Error(ERRORS.CLOSED);
            if (!exec.agent)
                throw Error(ERRORS.OWNING_SESSION_REQUIRED);
            if (!raw ||
                typeof raw !== "object" ||
                Array.isArray(raw) ||
                Reflect.ownKeys(raw).length)
                throw Error(ERRORS.INVALID_STATE_QUERY);
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
                return Promise.reject(Error(ERRORS.CLOSED));
            return executions.track(dispatch(raw, exec));
        },
    });
    async function dispatch(raw, exec) {
        if (!exec.agent)
            throw Error(ERRORS.OWNING_SESSION_REQUIRED);
        const agent = exec.agent;
        const owner = {
            sessionId: String(agent.id),
            callId: String(exec.callId),
        };
        const m = parse(raw);
        if (m.type !== "request")
            return bus.command(owner, m);
        // 宿主工具转发：仅 host.* handler 注入对应工具的 capability。
        const hostTool = hostToolFor(m.payload.handler);
        let projection;
        const attached = bus.submit(owner, m, (event) => projection?.progress(event), hostTool
            ? makeHostInvoke(exec, agent, hostTool.name, hostTool.errorCode)
            : undefined);
        // 1) 终态复用：已有执行直接读结果，不是新工作受理、不再申请 Job。
        const terminal = await readTerminal(attached);
        if (terminal)
            return terminal;
        // 2) 新执行：取得或创建宿主 Job 投影。
        const execution = await projectExecution(owner, m, attached, agent.id, (handle) => (projection = handle));
        // 3) 挂接取消生命周期，等待投影结算后返回执行快照。
        return await awaitProjection(exec, attached, execution);
    }
    /** 把 host.<tool> handler 名映射到宿主工具名与失败错误码。 */
    function hostToolFor(handler) {
        if (typeof handler !== "string" || !handler.startsWith("host."))
            return undefined;
        const name = handler.slice("host.".length);
        if (!name)
            return undefined;
        return {
            name,
            errorCode: name === "read" ? ERRORS.HOST_READ_FAILED : ERRORS.HOST_TOOL_FAILED,
        };
    }
    /** 为一类宿主工具构造转发能力：出队时重新进入宿主工具管线，沿用宿主权限与工作目录。 */
    function makeHostInvoke(exec, agent, toolName, errorCode) {
        return async (input, signal) => {
            const result = await ctx.tools.execute({
                name: toolName,
                callId: (String(exec.callId) +
                    ":bus:" +
                    randomUUID()),
                rootCallId: exec.rootCallId,
                parent: exec.token,
                agent,
                arguments: input,
                signal,
            });
            if (result.isError)
                throw Error(errorCode);
            return result.value;
        };
    }
    // —— 三个职责单一的拆分函数（闭包内共享 ctx/bus/executions） ——
    /** accepted 已是终态时直接返回现有结果；否则返回 undefined 走新执行路径。 */
    async function readTerminal(attached) {
        const state = attached.accepted.payload.state;
        if (state === "queued" || state === "running")
            return undefined;
        try {
            const value = await attached.done;
            attached.returned();
            return value;
        }
        finally {
            attached.detach();
        }
    }
    /** 命中已存在的共享投影则复用，否则创建投影；创建失败按 HOST_JOB_UNAVAILABLE 结算。 */
    async function projectExecution(owner, m, attached, ownerId, onProjected) {
        const jobKey = JSON.stringify([owner.sessionId, m.requestId]);
        const existing = executions.get(jobKey);
        if (existing) {
            // 只让第一个附着把进度投影到共享 Job；后续附着立即解除。
            attached.detach();
            return existing;
        }
        try {
            const created = executions.create(jobKey, ctx.jobs, ownerId, attached);
            onProjected(created);
            return created;
        }
        catch {
            attached.cancel();
            await attached.done;
            attached.detach();
            throw Error(ERRORS.HOST_JOB_UNAVAILABLE);
        }
    }
    /** 把宿主工具调用的取消映射到执行，并等待投影结算后返回快照。 */
    async function awaitProjection(exec, attached, execution) {
        const abort = () => attached.cancel();
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
