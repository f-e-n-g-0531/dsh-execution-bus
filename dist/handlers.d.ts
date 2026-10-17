import type { Handler } from "./bus.js";
/** 宿主工具转发 Handler 工厂：校验后把调用交回宿主工具管线执行。
 *  idempotent 由调用方按工具副作用显式声明；prepare 可补默认参数。 */
export declare function hostToolHandler(toolName: string, opts: {
    idempotent: boolean;
    validate(input: Record<string, unknown>): void;
    prepare?(input: Record<string, unknown>): Record<string, unknown>;
}): Handler;
export declare const testHandler: Handler;
/** 读取：无副作用，幂等，终态结果可复用。 */
export declare const readHandler: Handler;
/** 写入：有副作用，非幂等，终态结果不可复用。 */
export declare const writeHandler: Handler;
/** 编辑：有副作用，非幂等，终态结果不可复用。 */
export declare const editHandler: Handler;
