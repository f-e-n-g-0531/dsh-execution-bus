import { scopeOf } from "@deepseek-ai/dsh-scope";
import { apply as applyRuntime } from "./plugin.js";
import { PRODUCT, RUNTIME_INSTRUCTIONS } from "./product.js";
export const name = PRODUCT.modePluginName;
export const inject = ["tools", "systemPrompt"];
/** Additive preset row: presentation/tool inventory/authority stay with the host PTC composition. */
export function apply(ctx) {
    if (scopeOf(ctx) === undefined)
        throw Error("Xiao He mode requires an Agent preset scope");
    ctx.effect(() => ctx.systemPrompt.section({
        name: "XIAO_HE_DECLARATIVE_RUNTIME",
        order: 1700,
        text: RUNTIME_INSTRUCTIONS,
    }));
    applyRuntime(ctx);
}
