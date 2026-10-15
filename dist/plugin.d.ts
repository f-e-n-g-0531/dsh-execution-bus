import type { Context } from "@deepseek-ai/cordis";
declare module "@deepseek-ai/dsh-jobs" {
    interface JobKindMap {
        executionBus: "execution-bus";
    }
}
export declare const name = "execution-bus";
export declare const inject: string[];
export declare function apply(ctx: Context): void;
