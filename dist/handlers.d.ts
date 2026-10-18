import type { Handler } from "./bus.js";
/** 宿主工具转发 Handler 工厂：校验后把调用交回宿主工具管线执行。
 *  idempotent 由调用方按工具副作用显式声明；prepare 可补默认参数。 */
export declare function hostToolHandler(toolName: string, opts: {
    idempotent: boolean;
    validate(input: Record<string, unknown>): void;
    prepare?(input: Record<string, unknown>): Record<string, unknown>;
    queue?: string;
    maxConcurrency?: number;
    resources?(input: Record<string, unknown>): readonly string[];
    dedupe?: "payload";
}): Handler;
export declare const testHandler: Handler;
/** 读取：无副作用，幂等，终态结果可复用。0.12.1 起内置 host.* 不再声明
 *  payload 去重：文件/权限/工作目录会变化，缓存旧结果会静默返回过期内容。
 *  扩展 Handler 可自行声明 dedupe 并承担失效责任。 */
export declare const readHandler: Handler;
/** 文件名搜索：只读，幂等，终态结果可复用；搜索基数由宿主工具限制。 */
export declare const globHandler: Handler;
/** 内容搜索：只读，幂等，终态结果可复用；匹配上限由宿主工具限制。 */
export declare const grepHandler: Handler;
/** 写入：有副作用，非幂等，终态结果不可复用。 */
export declare const writeHandler: Handler;
/** 编辑：有副作用，非幂等，终态结果不可复用。 */
export declare const editHandler: Handler;
/** 命令执行：有副作用，非幂等，终态结果不可复用；后台模式返回 Job ID 不等于完成。 */
export declare const pwshHandler: Handler;
