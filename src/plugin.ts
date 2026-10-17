import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  ADMISSION_DEFAULTS,
  REQUEST_DESCRIPTION,
  REQUEST_PARAMETERS,
  STATE_PARAMETERS,
} from "./product.js";
import { ExecutionHandle, ExecutionOwner } from "./execution.js";
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    executionBus: "execution-bus";
  }
}
import { ExecutionBus, parse } from "./bus.js";
import { ERRORS } from "./error-codes.js";
import type { Message, Owner, RecordView } from "./bus.js";
import { testHandler, readHandler } from "./handlers.js";

/** bus.submit 的一次附着：accepted + 等待/取消/解除/交付标记。 */
type Submission = ReturnType<ExecutionBus["submit"]>;

export const name = "execution-bus";
export const inject = ["tools", "jobs"];
export function apply(ctx: Context) {
  const bus = new ExecutionBus(undefined, ADMISSION_DEFAULTS);
  bus.register("test", testHandler);
  bus.register("host.read", readHandler);
  const executions = new ExecutionOwner();
  ctx.effect(() => () => executions.close(() => bus.close()));

  ctx.tools.register({
    name: "execution_bus_state",
    description:
      "Read a bounded metadata-only snapshot of this agent session’s bus tasks. No inputs/results, no cross-session access. Do not poll during an awaited request.",
    parameters: STATE_PARAMETERS,
    output: {
      schema: {},
      render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }],
    },
    async execute(raw: unknown, exec: ToolRunContext) {
      if (executions.phase !== "open") throw Error(ERRORS.CLOSED);
      if (!exec.agent) throw Error(ERRORS.OWNING_SESSION_REQUIRED);
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Reflect.ownKeys(raw).length
      )
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
    execute(raw: unknown, exec: ToolRunContext) {
      if (executions.phase !== "open") return Promise.reject(Error(ERRORS.CLOSED));
      return executions.track(dispatch(raw, exec));
    },
  });

  async function dispatch(raw: unknown, exec: ToolRunContext) {
    if (!exec.agent) throw Error(ERRORS.OWNING_SESSION_REQUIRED);
    const agent = exec.agent;
    const owner: Owner = {
      sessionId: String(agent.id),
      callId: String(exec.callId),
    };
    const m: Message = parse(raw);
    if (m.type !== "request") return bus.command(owner, m);

    let projection: ExecutionHandle | undefined;
    const attached = bus.submit(
      owner,
      m,
      (event) => projection?.progress(event),
      // 宿主 read 能力：出队时重新进入宿主工具管线，沿用宿主权限与工作目录。
      async (input, signal) => {
        const result = await ctx.tools.execute({
          name: "read",
          callId: (String(exec.callId) +
            ":bus:" +
            randomUUID()) as typeof exec.callId,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          agent,
          arguments: input,
          signal,
        });
        if (result.isError) throw Error(ERRORS.HOST_READ_FAILED);
        return result.value;
      },
    );

    // 1) 终态复用：已有执行直接读结果，不是新工作受理、不再申请 Job。
    const terminal = await readTerminal(attached);
    if (terminal) return terminal;

    // 2) 新执行：取得或创建宿主 Job 投影。
    const execution = await projectExecution(
      owner,
      m,
      attached,
      agent.id,
      (handle) => (projection = handle),
    );

    // 3) 挂接取消生命周期，等待投影结算后返回执行快照。
    return await awaitProjection(exec, attached, execution);
  }

  // —— 三个职责单一的拆分函数（闭包内共享 ctx/bus/executions） ——

  /** accepted 已是终态时直接返回现有结果；否则返回 undefined 走新执行路径。 */
  async function readTerminal(
    attached: Submission,
  ): Promise<RecordView | undefined> {
    const state = attached.accepted.payload.state;
    if (state === "queued" || state === "running") return undefined;
    try {
      const value = await attached.done;
      attached.returned();
      return value;
    } finally {
      attached.detach();
    }
  }

  /** 命中已存在的共享投影则复用，否则创建投影；创建失败按 HOST_JOB_UNAVAILABLE 结算。 */
  async function projectExecution(
    owner: Owner,
    m: Message,
    attached: Submission,
    ownerId: SessionId,
    onProjected: (handle: ExecutionHandle) => void,
  ): Promise<ExecutionHandle> {
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
    } catch {
      attached.cancel();
      await attached.done;
      attached.detach();
      throw Error(ERRORS.HOST_JOB_UNAVAILABLE);
    }
  }

  /** 把宿主工具调用的取消映射到执行，并等待投影结算后返回快照。 */
  async function awaitProjection(
    exec: ToolRunContext,
    attached: Submission,
    execution: ExecutionHandle,
  ): Promise<RecordView> {
    const abort = () => attached.cancel();
    exec.signal.addEventListener("abort", abort, { once: true });
    if (exec.signal.aborted) abort();
    try {
      await execution.settled;
      const value = await attached.done;
      attached.returned();
      return value;
    } finally {
      exec.signal.removeEventListener("abort", abort);
      attached.detach();
    }
  }
}
