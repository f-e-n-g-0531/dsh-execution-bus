import { appendFileSync } from "node:fs";
import path from "node:path";
import { RuntimeService } from "../../dist/runtime/service.js";
import { RunStore } from "../../dist/runtime/store.js";

// This fixture is driven only through fork IPC. No wall-clock delay selects the
// crash point: the parent kills only after a durable checkpoint/entered barrier.
const [root, scenario, mode, recoveryId] = process.argv.slice(2);
const effects = path.join(process.cwd(), "effects.ndjson");
const owner = {
  agent: { id: "crash-owner" },
  callId: "crash-fixture",
  signal: new AbortController().signal,
};
const never = new Promise(() => {});
const send = (message) =>
  new Promise((resolve, reject) => {
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
const effect = (tag) =>
  appendFileSync(effects, JSON.stringify({ tag, pid: process.pid }) + "\n");
let barrierSent = false;
class CheckpointStore extends RunStore {
  save(run) {
    super.save(run);
    if (
      mode === "start" &&
      scenario === "completed-write" &&
      !barrierSent &&
      run.steps.find((step) => step.id === "fast")?.state === "succeeded" &&
      run.steps.find((step) => step.id === "slow")?.state === "running"
    ) {
      barrierSent = true;
      // super.save has atomically committed the successful fast result already.
      void send({
        type: "checkpoint",
        runId: run.runId,
        record: structuredClone(run),
      }).catch(fatal);
    }
  }
}
const store = new CheckpointStore(root);
const ctx = {
  tools: {
    async execute(call) {
      const tag = call.arguments.tag;
      effect(tag);
      if (
        mode === "start" &&
        scenario === "inflight-write" &&
        tag === "uncertain"
      ) {
        const run = store.list(100, owner.agent.id)[0];
        await send({ type: "write-entered", runId: run.runId, record: run });
        return never;
      }
      if (mode === "start" && tag === "slow") return never;
      return { isError: false, value: { tag, content: "result:" + tag } };
    },
  },
};
let service;
async function fatal(error) {
  try {
    await send({ type: "fatal", error: error?.stack ?? String(error) });
  } finally {
    process.exitCode = 1;
    process.disconnect();
  }
}
async function main() {
  service = new RuntimeService(ctx, store);
  const go = new Promise((resolve, reject) =>
    process.once("message", (message) => {
      if (message?.type !== "go") reject(Error("Expected go IPC message"));
      else resolve();
    }),
  );
  await send({ type: "ready", cwd: process.cwd(), pid: process.pid });
  await go;
  if (mode === "resume") {
    const before = service.result({ runId: recoveryId }, owner);
    const resumed = await service.resume({ runId: recoveryId }, owner);
    const result = service.result({ runId: recoveryId }, owner);
    await service.dispose();
    await send({ type: "result", before, resumed, result });
    process.disconnect();
    return;
  }
  const plan =
    scenario === "completed-write"
      ? {
          concurrency: 2,
          steps: [
            { id: "fast", tool: "write", input: { tag: "fast" } },
            { id: "slow", tool: "read", input: { tag: "slow" } },
          ],
        }
      : {
          concurrency: 1,
          steps: [
            { id: "uncertain", tool: "write", input: { tag: "uncertain" } },
            // Independent pending write: recovery must stop the WHOLE run, not only
            // descendants of the unknown side effect.
            { id: "after", tool: "write", input: { tag: "after" } },
          ],
        };
  const started = await service.run({ plan, async: true }, owner);
  await send({ type: "started", ...started });
}
void main().catch(fatal);
