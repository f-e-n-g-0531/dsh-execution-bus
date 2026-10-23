import { Service } from "@deepseek-ai/cordis";
import { entryListProblem } from "@deepseek-ai/dsh-agent-preset-registry";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { load } from "js-yaml";
import { setTimeout as pause } from "node:timers/promises";
import { PRODUCT } from "./product.js";
import { ERRORS } from "./error-codes.js";
export const PRESET_ID = PRODUCT.presetId;
/** 校验派生源组合：拒绝已含运行时，以及缺少公开基准地址的相对模块/include 子文件。 */
function validateDerivation(rows) {
    for (const row of rows) {
        if (row.id === "xiao-he-runtime" ||
            row.name?.startsWith("@feng0531/dsh-execution-bus"))
            throw Error(ERRORS.PTC_PRESET_ALREADY_CONTAINS_BUS);
        if (row.name?.startsWith(".") ||
            row.name === "@deepseek-ai/cordis-plugin-include")
            throw Error(ERRORS.PTC_PRESET_RELATIVE_BASE_UNSUPPORTED);
        if (row.group && Array.isArray(row.config))
            validateDerivation(row.config);
    }
}
/** Bound group traversal before the host's recursive shape validator sees YAML aliases. */
function validateGroupGraph(plugins) {
    const active = new Set();
    let rows = 0;
    const visit = (value, depth) => {
        if (!Array.isArray(value))
            return; // The host supplies the shape diagnostic.
        if (active.has(value))
            throw Error("Invalid PTC preset: cyclic plugin groups");
        if (depth > 64 || (rows += value.length) > 10000)
            throw Error("Invalid PTC preset: plugin group traversal limit exceeded");
        active.add(value);
        for (const row of value) {
            if (row && typeof row === "object" && row.group)
                visit(row.config, depth + 1);
        }
        active.delete(value);
    };
    visit(plugins, 0);
}
/** Capture the host-declared composition without evaluating !!js or changing disabled rows. */
export function derivePreset(content) {
    if (Buffer.byteLength(content) > 1048576)
        throw Error(ERRORS.PTC_PRESET_TOO_LARGE);
    const plugins = load(content, { schema: entryListSchema });
    validateGroupGraph(plugins);
    const problem = entryListProblem(plugins);
    if (problem)
        throw Error("Invalid PTC preset: " + problem);
    const rows = plugins;
    validateDerivation(rows);
    return {
        id: PRESET_ID,
        name: PRODUCT.name,
        order: 20,
        description: "继承宿主 PTC 工具组合，叠加声明式运行时（runtime_*）：DAG 计划、并行/重试/超时、落盘与恢复。普通任务使用原工具，授权和沙箱由宿主管理；不保证 exactly-once。",
        plugins: [
            ...rows,
            {
                id: "xiao-he-runtime",
                name: PRODUCT.modeEntry,
            },
        ],
    };
}
/** Host-plane registrar. readDocument is a public serialized declaration, not a private registry read. */
export default class XiaoHePreset {
    ctx;
    static inject = ["agentPresets"];
    constructor(ctx) {
        this.ctx = ctx;
    }
    async *[Service.init]() {
        let document;
        for (let attempt = 0; attempt < 50; attempt++) {
            try {
                document = await this.ctx.agentPresets.readDocument("ptc");
                break;
            }
            catch (error) {
                if (!(error instanceof Error) ||
                    !("code" in error) ||
                    error.code !== "agent-preset/not-found")
                    throw error;
                if (attempt === 49)
                    throw Error("Xiao He requires a declared ptc preset. Load the host PTC preset before this bundle.");
                await pause(100);
            }
        }
        if (!document)
            throw Error(ERRORS.PTC_PRESET_UNAVAILABLE);
        yield await this.ctx.agentPresets.register(derivePreset(document.content));
    }
}
