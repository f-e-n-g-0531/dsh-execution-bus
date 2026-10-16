import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { ExecutionHandle, ExecutionOwner } from "./execution.js";
declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    executionBus: "execution-bus";
  }
}
import { ExecutionBus, parse } from "./bus.js";
import { testHandler, readHandler } from "./handlers.js";
export const name = "execution-bus";
export const inject = ["tools", "jobs"];
export function apply(ctx: Context) {
  const bus = new ExecutionBus();
  bus.register("test", testHandler);
  bus.register("host.read", readHandler);
  const executions = new ExecutionOwner();
  ctx.effect(() => () => executions.close(() => bus.close()));
  ctx.tools.register({
    name: "execution_bus",
    description:
      "萧何 / Xiao He. Submit a version 1 request and WAIT for its terminal result in this tool call. Reuse requestId only for the same logical operation. Handlers: test {delayMs:0..30000,fail:boolean}, host.read {file_path,offset?,limit?<=100}. Control types status/result/cancel use empty payload. Acceptance is volatile, not execution success. No polling needed; no restart resume.",
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
    execute(raw: unknown, exec: ToolRunContext) {
      if (executions.phase !== "open") return Promise.reject(Error("CLOSED"));
      return executions.track(dispatch(raw, exec));
    },
  });
  async function dispatch(raw: unknown, exec: ToolRunContext) {
    if (!exec.agent) throw Error("OWNING_SESSION_REQUIRED");
    const owner = {
        sessionId: String(exec.agent.id),
        callId: String(exec.callId),
      },
      m = parse(raw);
    if (m.type !== "request") return bus.command(owner, m);
    let projection: ExecutionHandle | undefined;
    const attached = bus.submit(
      owner,
      m,
      (event) => projection?.progress(event),
      async (input, signal) => {
        const result = await ctx.tools.execute({
          name: "read",
          callId: (String(exec.callId) +
            ":bus:" +
            randomUUID()) as typeof exec.callId,
          rootCallId: exec.rootCallId,
          parent: exec.token,
          agent: exec.agent,
          arguments: input,
          signal,
        });
        if (result.isError) throw Error("HOST_READ_FAILED");
        return result.value;
      },
    );
    // Terminal reuse is a read of an existing result, not admission of new work.
    if (
      attached.accepted.payload.state !== "queued" &&
      attached.accepted.payload.state !== "running"
    ) {
      try {
        const value = await attached.done;
        attached.returned();
        return value;
      } finally {
        attached.detach();
      }
    }
    const abort = () => attached.cancel();
    const jobKey = JSON.stringify([owner.sessionId, m.requestId]);
    let execution = executions.get(jobKey);
    if (execution) attached.detach(); // only the first attachment projects progress into the shared Job
    if (!execution) {
      try {
        execution = executions.create(
          jobKey,
          ctx.jobs,
          exec.agent.id,
          attached,
        );
        projection = execution;
      } catch {
        abort();
        await attached.done;
        attached.detach();
        throw Error("HOST_JOB_UNAVAILABLE");
      }
    }
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
