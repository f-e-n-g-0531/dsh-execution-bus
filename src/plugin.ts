import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
  ADMISSION_DEFAULTS,
  REQUEST_DESCRIPTION,
  REQUEST_PARAMETERS,
  RUNTIME_CANCEL_DESCRIPTION,
  RUNTIME_RESULT_DESCRIPTION,
  RUNTIME_RESUME_DESCRIPTION,
  RUNTIME_RUN_DESCRIPTION,
  RUNTIME_RUN_ID_PARAMETERS,
  RUNTIME_RUN_PARAMETERS,
  RUNTIME_STATE_PARAMETERS,
  RUNTIME_STATUS_DESCRIPTION,
  RUNTIME_STATUS_PARAMETERS,
  STATE_PARAMETERS,
} from "./product.js";
import { RuntimeService } from "./runtime/service.js";
import { ExecutionHandle, ExecutionOwner } from "./execution.js";
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    executionBus: "execution-bus";
  }
}
import { ExecutionBus, parse } from "./bus.js";
import { ERRORS } from "./error-codes.js";
import type { Message, Owner, RecordView } from "./bus.js";
import {
  testHandler,
  readHandler,
  globHandler,
  grepHandler,
  editHandler,
  writeHandler,
  pwshHandler,
} from "./handlers.js";

/** bus.submit 的一次附着：accepted + 等待/取消/解除/交付标记。 */
type Submission = ReturnType<ExecutionBus["submit"]>;

/** DSH 0.2.1-rc.2 的 PTC 在程序结束（含时间预算到期）时用它作为子调用中断原因；
 *  用户/会话取消使用调用方提供的原因，不匹配该固定字符串。 */
const PTC_PROGRAM_SETTLED = "run_code settled";

function isPtcProgramEnd(signal: AbortSignal) {
  return signal.aborted && signal.reason === PTC_PROGRAM_SETTLED;
}

const REQUEST_KEYS = new Set(["requestId", "messageId", "handler", "input"]);
const CONTROL_KEYS = new Set(["requestId", "messageId", "type"]);

/** 工具入口兼容两种形状：0.11.0 简化调用 {requestId,handler,input,messageId?}
 *  或 {requestId,type,messageId?}，以及完整 v1 消息。简化形状在进入总线前补齐协议字段。 */
function normalizeToolInput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  if (Object.hasOwn(input, "protocolVersion")) return raw;
  if (
    Object.keys(input).some(
      (key) => !REQUEST_KEYS.has(key) && !CONTROL_KEYS.has(key),
    ) ||
    typeof input.requestId !== "string"
  )
    throw Error(ERRORS.INVALID_REQUEST);
  const messageId =
    typeof input.messageId === "string" ? input.messageId : randomUUID();
  if (Object.hasOwn(input, "handler")) {
    if (
      Object.hasOwn(input, "type") ||
      typeof input.handler !== "string"
    )
      throw Error(ERRORS.INVALID_REQUEST);
    return {
      protocolVersion: 1,
      messageId,
      requestId: input.requestId,
      type: "request",
      payload: { handler: input.handler, input: input.input },
    };
  }
  if (
    typeof input.type !== "string" ||
    !["status", "result", "cancel"].includes(input.type)
  )
    throw Error(ERRORS.INVALID_REQUEST);
  return {
    protocolVersion: 1,
    messageId,
    requestId: input.requestId,
    type: input.type,
    payload: {},
  };
}

export const name = "execution-bus";
export const inject = ["tools", "jobs"];
export function apply(ctx: Context) {
  const bus = new ExecutionBus(undefined, ADMISSION_DEFAULTS);
  bus.register("test", testHandler);
  bus.register("host.read", readHandler);
  bus.register("host.glob", globHandler);
  bus.register("host.grep", grepHandler);
  bus.register("host.edit", editHandler);
  bus.register("host.write", writeHandler);
  bus.register("host.pwsh", pwshHandler);
  const executions = new ExecutionOwner();
  ctx.effect(() => () => executions.close(() => bus.close()));
  const runtime = new RuntimeService(ctx);
  ctx.effect(() => () => runtime.dispose());

  const registerRuntimeTool = (
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    execute: (raw: unknown, exec: ToolRunContext) => unknown,
  ) => {
    ctx.tools.register({
      name,
      description,
      parameters,
      output: {
        schema: {},
        render: (_args: unknown, value: unknown) => [
          { type: "text", text: JSON.stringify(value) },
        ],
      },
      async execute(raw: unknown, exec: ToolRunContext) {
        if (executions.phase !== "open") throw Error(ERRORS.CLOSED);
        return execute(raw, exec);
      },
    });
  };
  registerRuntimeTool(
    "runtime_run",
    RUNTIME_RUN_DESCRIPTION,
    RUNTIME_RUN_PARAMETERS,
    (raw, exec) => runtime.run(raw, exec),
  );
  registerRuntimeTool(
    "runtime_status",
    RUNTIME_STATUS_DESCRIPTION,
    RUNTIME_STATUS_PARAMETERS,
    (raw, exec) => runtime.status(raw, exec),
  );
  registerRuntimeTool(
    "runtime_result",
    RUNTIME_RESULT_DESCRIPTION,
    RUNTIME_RUN_ID_PARAMETERS,
    (raw, exec) => runtime.result(raw, exec),
  );
  registerRuntimeTool(
    "runtime_cancel",
    RUNTIME_CANCEL_DESCRIPTION,
    RUNTIME_RUN_ID_PARAMETERS,
    (raw, exec) => runtime.cancel(raw, exec),
  );
  registerRuntimeTool(
    "runtime_resume",
    RUNTIME_RESUME_DESCRIPTION,
    RUNTIME_RUN_ID_PARAMETERS,
    (raw, exec) => runtime.resume(raw, exec),
  );
  // RUNTIME_STATE_PARAMETERS 保留导出给后续只读快照工具使用。
  void RUNTIME_STATE_PARAMETERS;

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
    const m: Message = parse(normalizeToolInput(raw));
    if (m.type !== "request") return bus.command(owner, m);

    // 宿主工具转发：仅 host.* handler 注入对应工具的 capability。
    const hostTool = hostToolFor(m.payload.handler);
    let projection: ExecutionHandle | undefined;
    const attached = bus.submit(
      owner,
      m,
      (event) => projection?.progress(event),
      hostTool
        ? makeHostInvoke(exec, agent, hostTool.name, hostTool.errorCode)
        : undefined,
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

  /** 把 host.<tool> handler 名映射到宿主工具名与失败错误码。 */
  function hostToolFor(handler: unknown) {
    if (typeof handler !== "string" || !handler.startsWith("host."))
      return undefined;
    const name = handler.slice("host.".length);
    if (!name) return undefined;
    return {
      name,
      errorCode:
        name === "read" ? ERRORS.HOST_READ_FAILED : ERRORS.HOST_TOOL_FAILED,
    };
  }

  /** 为一类宿主工具构造转发能力：出队时重新进入宿主工具管线，沿用宿主权限与工作目录。 */
  function makeHostInvoke(
    exec: ToolRunContext,
    agent: NonNullable<ToolRunContext["agent"]>,
    toolName: string,
    errorCode: string,
  ) {
    return async (input: Record<string, unknown>, signal: AbortSignal) => {
      const result = await ctx.tools.execute({
        name: toolName,
        callId: (String(exec.callId) +
          ":bus:" +
          randomUUID()) as typeof exec.callId,
        rootCallId: exec.rootCallId,
        parent: exec.token,
        agent,
        arguments: input,
        signal,
      });
      if (result.isError) throw Error(errorCode);
      return result.value;
    };
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
      return markReused(value, attached);
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

  /** 本次调用是否复用了已有执行；仅在真复用时追加标记，保持首次快照形状不变。 */
  function markReused(view: RecordView, attached: Submission): RecordView {
    return attached.reused ? { ...view, reused: true } : view;
  }

  /** 外层取消映射：PTC 程序结束（含预算到期）只停止本次等待，已受理执行与
   *  宿主 Job 保留，同会话可用同 requestId 的 status/result 取回；其他取消原因
   *  （用户/会话中断）仍请求取消整个执行。 */
  async function awaitProjection(
    exec: ToolRunContext,
    attached: Submission,
    execution: ExecutionHandle,
  ): Promise<RecordView> {
    let release!: (view: RecordView) => void;
    const detachedView = new Promise<RecordView>((resolve) => (release = resolve));
    const abort = () => {
      if (!isPtcProgramEnd(exec.signal)) {
        attached.cancel();
        return;
      }
      attached.detach();
      release(attached.snapshot());
    };
    exec.signal.addEventListener("abort", abort, { once: true });
    if (exec.signal.aborted) abort();
    const settled = execution.settled.then(
      () => ({ kind: "settled" }) as const,
      (error: unknown) => ({ kind: "error", error }) as const,
    );
    try {
      const outcome = await Promise.race([
        settled,
        detachedView.then((view) => ({ kind: "detached" as const, view })),
      ]);
      if (outcome.kind === "detached") return markReused(outcome.view, attached);
      if (outcome.kind === "error") throw outcome.error;
      const value = await attached.done;
      attached.returned();
      return markReused(value, attached);
    } finally {
      exec.signal.removeEventListener("abort", abort);
      attached.detach();
    }
  }
}
