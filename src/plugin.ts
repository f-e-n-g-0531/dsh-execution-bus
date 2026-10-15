import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { JobHandle, JobOutcome } from "@deepseek-ai/dsh-jobs";
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
  const sharedJobs = new Map<string, Promise<void>>();
  ctx.effect(() => async () => {
    await bus.close();
    await Promise.allSettled(sharedJobs.values());
    sharedJobs.clear();
  });
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
    async execute(raw: unknown, exec: ToolRunContext) {
      if (!exec.agent) throw Error("OWNING_SESSION_REQUIRED");
      const owner = {
          sessionId: String(exec.agent.id),
          callId: String(exec.callId),
        },
        m = parse(raw);
      if (m.type !== "request") return bus.command(owner, m);
      let handle: JobHandle | undefined;
      const attached = bus.submit(
        owner,
        m,
        (event) =>
          handle?.updateProgress(
            event.type === "progress"
              ? String(event.payload.percent) + "%"
              : event.type,
          ),
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
      let settled = sharedJobs.get(jobKey);
      if (!settled) {
        try {
          const outcome = attached.done.then(
            (v): JobOutcome => ({
              status:
                v.state === "succeeded"
                  ? "completed"
                  : v.state === "cancelled"
                    ? "killed"
                    : "failed",
              detail: v.state,
            }),
          );
          const job = ctx.jobs.start({
            kind: "execution-bus",
            label: "萧何 / Xiao He",
            owner: exec.agent.id,
            run(h) {
              handle = h;
              return {
                done: outcome,
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
            } catch (error) {
              // rc.2 has no typed not-found code. Match only this minted Job and
              // confirm absence in the original owner scope; never swallow access/service errors.
              let alreadyRemoved = false;
              try {
                alreadyRemoved =
                  error instanceof Error &&
                  error.message === `unknown job ${job}` &&
                  !ctx.jobs.list(ownerId).some((view) => view.id === job);
              } catch {
                /* Preserve the original wait/cleanup error. */
              }
              // A broken wait channel does not terminate execution. Keep caller cancellation
              // attached, drain both producer and host outcome, then attempt cleanup once.
              await attached.done;
              if (!alreadyRemoved) {
                // No scope-owned observer: teardown can remove it before settlement.
                // After producer drain, allow a bounded host commit window. This is
                // program-side cleanup only, never execution retry or model polling.
                for (let attempt = 0; attempt < 20; attempt++) {
                  try {
                    const view = ctx.jobs
                      .list(ownerId)
                      .find(
                        (view) => view.id === job && view.owner === ownerId,
                      );
                    if (!view) break;
                    if (
                      view.status !== "running" &&
                      view.status !== "stopping"
                    ) {
                      ctx.jobs.remove(job, ownerId);
                      break;
                    }
                  } catch {
                    break;
                  }
                  await pause(10);
                }
                throw error;
              }
            }
          })();
          sharedJobs.set(jobKey, settled);
          void settled.then(
            () => sharedJobs.delete(jobKey),
            () => sharedJobs.delete(jobKey),
          );
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
        await settled;
        const value = await attached.done;
        attached.returned();
        return value;
      } finally {
        exec.signal.removeEventListener("abort", abort);
        attached.detach();
      }
    },
  });
}
