import type { Context } from "@deepseek-ai/cordis";
export declare const name = "xiao-he-runtime";
export declare const inject: string[];
/** 声明式运行时插件：只暴露 runtime_* 工具，执行/持久化在 RuntimeService。 */
export declare function apply(ctx: Context): void;
