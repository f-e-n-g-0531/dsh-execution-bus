import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessError } from "@deepseek-ai/dsh-llm";
import { RuntimeService } from "../dist/runtime/service.js";
import { RunStore } from "../dist/runtime/store.js";
import { createServiceContext } from "./fixtures/service-context.mjs";

for (const [code, expected] of [
  ["FS_PERMISSION_DENIED", 1],
  ["INVALID_ARGS", 1],
  ["FS_NOT_FOUND", 1],
  ["EAGAIN", 2],
  [undefined, 2],
]) {
  test(
    "real pipeline preserves retry classification without exposing host detail: " +
      (code ?? "legacy_unknown"),
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "xiaohe-retry-host-"));
      let calls = 0;
      const ctx = createServiceContext(async () => {
        calls++;
        if (calls === 1)
          throw code
            ? new HarnessError("secret path/token", code)
            : Error("secret path/token");
        return "ok";
      });
      const service = new RuntimeService(ctx, new RunStore(root));
      const exec = {
        agent: { id: "owner" },
        callId: "retry-host",
        signal: new AbortController().signal,
      };
      try {
        const run = await service.run(
          {
            plan: {
              steps: [{ id: "read", tool: "read", input: {}, retry: 1 }],
            },
          },
          exec,
        );
        assert.equal(calls, expected);
        assert.equal(run.steps[0].attempts, expected);
        assert.equal(run.state, expected === 1 ? "failed" : "succeeded");
        assert.doesNotMatch(
          JSON.stringify(run),
          /secret|token|FS_PERMISSION_DENIED|EAGAIN/,
        );
      } finally {
        await service.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
