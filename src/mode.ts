import type { Context } from "@deepseek-ai/cordis";
import { scopeOf } from "@deepseek-ai/dsh-scope";
import { apply as applyBus } from "./plugin.js";
import { PRODUCT, MODE_INSTRUCTIONS, RUNTIME_INSTRUCTIONS } from "./product.js";
export const name = PRODUCT.modePluginName;
export const inject = ["tools", "jobs", "systemPrompt"];
/** An additive preset row: presentation, tool inventory and authority belong to the host PTC composition. */
export function apply(ctx: Context) {
  if (scopeOf(ctx) === undefined)
    throw Error("Xiao He mode requires an Agent preset scope");
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: "XIAO_HE_EXECUTION_BUS",
      order: 1700,
      text: MODE_INSTRUCTIONS,
    }),
  );
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: "XIAO_HE_DECLARATIVE_RUNTIME",
      order: 1701,
      text: RUNTIME_INSTRUCTIONS,
    }),
  );
  applyBus(ctx);
}
