/** 集中定义跨模块共享的固定数值上限。内部实现约束，非用户可配置项。
 *  数值相同时语义依然独立，勿为了“省一个常量”而合并。 */
const ID_MAX_LENGTH = 128;
export const LIMITS = Object.freeze({
    /** 单条协议消息 JSON 的最大字节数（parse 拒绝更大消息）。 */
    messageMaxBytes: 16384,
    /** messageId / requestId 的最大字符数。 */
    idMaxLength: ID_MAX_LENGTH,
    /** messageId / requestId 的合法字符集。 */
    idPattern: new RegExp(`^[a-zA-Z0-9_.:-]{1,${ID_MAX_LENGTH}}$`),
    /** 单个逻辑执行所记账的消息条数上限（含首次、重复请求与查询）。 */
    messageAccountLimit: 128,
    /** 单个执行可同时附着的观察者上限。 */
    waiterLimit: 32,
    /** inspect() 单次返回的任务元数据条数上限。 */
    inspectTaskLimit: 50,
    /** 严格 JSON 树的最大嵌套深度。 */
    jsonMaxDepth: 64,
    /** 严格 JSON 树可访问的节点总数预算。 */
    jsonNodeBudget: 65536,
    /** 诊断环形轨迹的槽位数量。 */
    traceRingSize: 128,
});
