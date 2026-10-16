import { Context, Service } from "@deepseek-ai/cordis";
import type { PresetDefinition } from "@deepseek-ai/dsh-agent-preset-registry";
export declare const PRESET_ID = "execution-bus-test";
/** Capture the host-declared composition without evaluating !!js or changing disabled rows. */
export declare function derivePreset(content: string): PresetDefinition;
/** Host-plane registrar. readDocument is a public serialized declaration, not a private registry read. */
export default class XiaoHePreset {
    private ctx;
    static inject: string[];
    constructor(ctx: Context);
    [Service.init](): AsyncGenerator<() => Promise<void>, void, unknown>;
}
