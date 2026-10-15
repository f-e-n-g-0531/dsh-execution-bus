import type { Context } from "@deepseek-ai/cordis";
export declare const name = "execution-bus-test-mode";
export declare const inject: string[];
/** Must be mounted inside the host's preset scope, never in the global composition. */
export declare function apply(ctx: Context): void;
