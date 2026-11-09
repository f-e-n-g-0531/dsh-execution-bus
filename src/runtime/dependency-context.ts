import { createHash } from "node:crypto";
import { ERRORS } from "../error-codes.js";
import type { RunRecord } from "./store.js";
import type { PlanStep } from "./plan.js";

export interface DependencyPage {
  ref: string;
  hash: string;
  offset: number;
  total: number;
  text: string;
  nextOffset?: number;
}
export interface DependencyContext {
  readonly ownerSessionId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly previews: ReadonlyArray<{
    id: string;
    ref: string;
    hash: string;
    total: number;
    preview: string;
  }>;
  read(input: unknown): DependencyPage;
}
/** Invocation-scoped capability; references confer no authority outside this closure. */
export function dependencyContext(
  run: RunRecord,
  spec: PlanStep,
  signal: AbortSignal,
): DependencyContext {
  const entries = new Map<string, { text: string; hash: string }>();
  const previews = spec.dependsOn.map((id) => {
    const stored = run.results[id];
    if (
      !stored ||
      stored.truncated ||
      !Object.hasOwn(stored, "value") ||
      !run.steps.some((step) => step.id === id && step.state === "succeeded")
    )
      throw Error(ERRORS.RUNTIME_AGENT_DEPENDENCY_UNAVAILABLE);
    const text = JSON.stringify(stored.value);
    if (typeof text !== "string")
      throw Error(ERRORS.RUNTIME_AGENT_DEPENDENCY_UNAVAILABLE);
    const hash = createHash("sha256").update(text).digest("hex");
    const ref = createHash("sha256")
      .update(
        JSON.stringify([run.ownerSessionId, run.runId, spec.id, id, hash]),
      )
      .digest("hex");
    entries.set(ref, { text, hash });
    const points = Array.from(text);
    return Object.freeze({
      id,
      ref,
      hash,
      total: points.length,
      preview: points.slice(0, 256).join(""),
    });
  });
  return Object.freeze({
    ownerSessionId: run.ownerSessionId,
    runId: run.runId,
    stepId: spec.id,
    previews: Object.freeze(previews),
    read(input: unknown): DependencyPage {
      if (signal.aborted) throw Error(ERRORS.RUNTIME_AGENT_ABORTED);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input))
      )
        throw Error(ERRORS.INVALID_PLAN);
      for (const key of Reflect.ownKeys(input)) {
        const d = Object.getOwnPropertyDescriptor(input, key)!;
        if (
          typeof key !== "string" ||
          !["ref", "hash", "offset", "limit"].includes(key) ||
          !("value" in d) ||
          !d.enumerable
        )
          throw Error(ERRORS.INVALID_PLAN);
      }
      const {
        ref,
        hash,
        offset = 0,
        limit = 2048,
      } = input as Record<string, unknown>;
      if (
        typeof ref !== "string" ||
        typeof hash !== "string" ||
        !Number.isSafeInteger(offset) ||
        Number(offset) < 0 ||
        !Number.isSafeInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 4096
      )
        throw Error(ERRORS.INVALID_PLAN);
      const entry = entries.get(ref);
      if (!entry) throw Error(ERRORS.RUNTIME_RESULT_UNAVAILABLE);
      if (entry.hash !== hash) throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
      const points = Array.from(entry.text);
      if (Number(offset) > points.length) throw Error(ERRORS.INVALID_PLAN);
      const end = Math.min(Number(offset) + Number(limit), points.length);
      return {
        ref,
        hash,
        offset: Number(offset),
        total: points.length,
        text: points.slice(Number(offset), end).join(""),
        ...(end < points.length ? { nextOffset: end } : {}),
      };
    },
  });
}
