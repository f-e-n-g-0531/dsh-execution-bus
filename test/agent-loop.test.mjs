// Real host AgentLoop and sessions; deterministic model fixture, NOT a real-model benchmark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { AgentRegistry } from "@deepseek-ai/dsh-agent";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import {
  LlmRuntime,
  LlmAdapter,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Jobs from "@deepseek-ai/dsh-jobs-local";
import { createScope } from "@deepseek-ai/dsh-scope";
import * as plugin from "../dist/plugin.js";
test(
  "real AgentLoop submits original-call result once and continues only after completion (scripted adapter)",
  { timeout: 10000 },
  async () => {
    const ctx = new Context();
    new AgentRegistry(ctx);
    new SessionStore(ctx);
    new SessionProjectionRegistry(ctx);
    new SystemPrompt(ctx, {});
    new LlmRuntime(ctx);
    new ToolRuntime(ctx, {});
    new Jobs(ctx, Jobs.Config({}));
    ctx.jobs.attachController("test");
    let calls = 0;
    const events = [];
    ctx.on("session/event", (_s, e) => events.push(e));
    class Scripted extends LlmAdapter {
      async *stream(options) {
        calls++;
        if (calls === 1) {
          const block = {
            type: "tool-call",
            id: "original-call",
            name: "execution_bus",
            arguments: JSON.stringify({
              protocolVersion: 1,
              messageId: "m",
              requestId: "r",
              type: "request",
              payload: { handler: "test", input: { delayMs: 50, fail: false } },
            }),
          };
          yield { type: "block-start", index: 0, blockType: "tool-call" };
          yield {
            type: "tool-call-delta",
            index: 0,
            id: block.id,
            name: block.name,
            argumentsDelta: block.arguments,
          };
          yield { type: "block-end", index: 0, block };
          yield { type: "finish", reason: "tool-calls" };
        } else {
          assert.ok(events.some((e) => e.type === "tool/result"));
          const block = { type: "text", text: "done" };
          yield { type: "block-start", index: 0, blockType: "text" };
          yield { type: "text-delta", index: 0, text: "done" };
          yield { type: "block-end", index: 0, block };
          yield { type: "finish", reason: "stop" };
        }
      }
    }
    ctx.llm.registerAdapter(["scripted"], new Scripted());
    new AgentLoop(ctx, AgentLoop.Config({}));
    const scope = createScope(ctx, {});
    plugin.apply(ctx);
    const h = await ctx.agents.create({
      sessionId: "loop-smoke",
      agentOptions: { provider: "scripted", model: "fixture" },
    });
    try {
      h.agent.send(
        createUserMessage({
          content: [{ type: "text", text: "run" }],
          source: { kind: "user" },
        }),
        "next-turn",
        true,
      );
      await h.agent.whenIdle();
      assert.equal(calls, 2, JSON.stringify(events));
      const results = events.filter((e) => e.type === "tool/result");
      assert.equal(results.length, 1, JSON.stringify(events));
      assert.equal(results[0].data.message.toolCallId, "original-call");
      assert.notEqual(results[0].data.message.isError, true);
      assert.match(
        JSON.stringify(results[0].data.message.content),
        /succeeded/,
      );
      const callEvent = events.find((e) => e.type === "tool/call");
      assert.ok(JSON.stringify(results[0]).includes(String(callEvent.seq)));
      assert.equal(events.filter((e) => e.type === "tool/call").length, 1);
    } finally {
      await h.dispose();
      await scope.dispose();
    }
  },
);
