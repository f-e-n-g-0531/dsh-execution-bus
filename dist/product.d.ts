/** Stable product identities and model-visible runtime policy. */
export declare const PRODUCT: Readonly<{
    name: "萧何 / Xiao He";
    packageName: "@feng0531/dsh-execution-bus";
    presetId: "xiao-he-runtime";
    presetRowId: "preset-xiao-he-runtime";
    modeEntry: "@feng0531/dsh-execution-bus/mode";
    modePluginName: "xiao-he-runtime-mode";
}>;
export declare const RUNTIME_RUN_PARAMETERS: {
    readonly type: "object";
    readonly properties: {
        readonly plan: {
            readonly type: "object";
            readonly properties: {
                readonly goal: {
                    readonly type: "string";
                    readonly maxLength: 500;
                };
                readonly concurrency: {
                    readonly type: "integer";
                    readonly minimum: 1;
                    readonly maximum: 4;
                };
                readonly steps: {
                    readonly type: "array";
                    readonly items: {
                        readonly type: "object";
                        readonly properties: {
                            readonly id: {
                                readonly type: "string";
                                readonly description: "步骤唯一 ID（字母开头，可含字母/数字/_-）";
                            };
                            readonly tool: {
                                readonly type: "string";
                                readonly enum: readonly ["read", "glob", "grep", "edit", "write", "pwsh"];
                                readonly description: "允许的宿主工具";
                            };
                            readonly input: {
                                readonly type: "object";
                                readonly description: "宿主工具参数，按工具 schema 校验；不做前置结果插值，pwsh 禁止 run_in_background:true";
                            };
                            readonly depends_on: {
                                readonly type: "array";
                                readonly items: {
                                    readonly type: "string";
                                };
                                readonly description: "依赖步骤 ID；全部成功后本步骤才执行";
                            };
                            readonly retry: {
                                readonly type: "integer";
                                readonly minimum: 0;
                                readonly maximum: 3;
                                readonly description: "仅幂等工具 read/glob/grep 允许 >0；重试次数不含首次";
                            };
                            readonly timeout_ms: {
                                readonly type: "integer";
                                readonly minimum: 1000;
                                readonly maximum: 600000;
                            };
                        };
                        readonly required: readonly ["id", "tool", "input"];
                        readonly additionalProperties: false;
                    };
                    readonly minItems: 1;
                    readonly maxItems: 32;
                };
            };
            readonly required: readonly ["steps"];
            readonly additionalProperties: false;
        };
        readonly async: {
            readonly type: "boolean";
            readonly description: "true 时立即返回 runId，用 runtime_status/runtime_result 取回";
        };
    };
    readonly required: readonly ["plan"];
    readonly additionalProperties: false;
};
export declare const RUNTIME_RUN_ID_PARAMETERS: {
    readonly type: "object";
    readonly properties: {
        readonly runId: {
            readonly type: "string";
            readonly description: "runtime_run 返回的运行 ID";
        };
    };
    readonly required: readonly ["runId"];
    readonly additionalProperties: false;
};
export declare const RUNTIME_STATUS_PARAMETERS: {
    readonly type: "object";
    readonly properties: {
        readonly runId: {
            readonly type: "string";
            readonly description: "可选：指定运行 ID；省略时列出本会话最近运行";
        };
        readonly limit: {
            readonly type: "integer";
            readonly minimum: 1;
            readonly maximum: 100;
            readonly description: "仅列表：每页条数，默认 20";
        };
        readonly offset: {
            readonly type: "integer";
            readonly minimum: 0;
            readonly maximum: 10000;
            readonly description: "仅列表：跳过条数，默认 0";
        };
    };
    readonly additionalProperties: false;
};
export declare const RUNTIME_RUN_DESCRIPTION = "\u8427\u4F55\u58F0\u660E\u5F0F\u8FD0\u884C\u65F6\uFF1A\u63D0\u4EA4 DAG \u8BA1\u5212\uFF08steps\uFF1Aid/tool/input/depends_on/retry/timeout_ms\uFF09\uFF0C\u7531\u7A0B\u5E8F\u6309\u4F9D\u8D56\u5E76\u884C\u6267\u884C\u3001\u5BF9\u53EA\u8BFB\u6B65\u9AA4\u91CD\u8BD5\u3001\u9010\u6B65\u843D\u76D8\u3002\u9ED8\u8BA4\u7B49\u5F85\u5B8C\u6210\u8FD4\u56DE\u6B65\u9AA4\u72B6\u6001\uFF1Basync:true \u7ACB\u5373\u8FD4\u56DE runId\uFF0C\u7528 runtime_status/runtime_result \u53D6\u56DE\uFF0Cruntime_cancel \u53D6\u6D88\u3002\u4EC5\u5141\u8BB8 read/glob/grep/edit/write/pwsh\uFF1B\u526F\u4F5C\u7528\u6B65\u9AA4\u4E0D\u91CD\u8BD5\u3001\u5D29\u6E83\u540E\u5728\u9014\u6B65\u9AA4\u6807\u8BB0 unknown\uFF08\u4E0D\u505A exactly-once \u56DE\u6EDA\uFF09\u3002\u7B80\u5355\u4E00\u6B21\u8C03\u7528\u8BF7\u76F4\u63A5\u7528\u539F\u5DE5\u5177\u3002";
export declare const RUNTIME_STATUS_DESCRIPTION = "\u8BFB\u53D6\u672C\u4F1A\u8BDD\u7684\u8FD0\u884C\u5143\u6570\u636E\uFF1A\u4E0D\u5E26 runId \u6309 limit/offset \u5206\u9875\uFF08\u9ED8\u8BA4 20/0\uFF09\uFF1B\u5E26 runId \u8FD4\u56DE\u6307\u5B9A\u8FD0\u884C\u4E0E\u6B65\u9AA4\u72B6\u6001\u3001progress \u8BA1\u6570\u4E0E guidance \u5B89\u5168\u5EFA\u8BAE\uFF0C\u4E0D\u542B\u539F\u59CB\u6B65\u9AA4\u7ED3\u679C\u3002\u5EFA\u8BAE\u4EC5\u4F9B\u539F owner \u663E\u5F0F\u5904\u7F6E\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u6267\u884C\u3002\u4E0D\u8981\u8F6E\u8BE2\u6B63\u5728\u7B49\u5F85\u7684 runtime_run\u3002";
export declare const RUNTIME_RESULT_DESCRIPTION = "\u8BFB\u53D6\u672C\u4F1A\u8BDD\u6307\u5B9A\u8FD0\u884C\u5DF2\u4FDD\u5B58\u7684\u6B65\u9AA4\u7ED3\u679C\u3001progress \u4E0E guidance\uFF08\u5355\u6B65\u7ED3\u679C\u8D85\u8FC7 64KiB \u65F6\u53EA\u8FD4\u56DE truncated/bytes \u6807\u8BB0\uFF09\u3002finished \u4EC5\u8868\u793A\u8FD0\u884C\u8C03\u5EA6\u7EC8\u6001\uFF0C\u4E0D\u786E\u8BA4\u5BBF\u4E3B\u8FDB\u7A0B\u6216\u540E\u53F0 Job \u5DF2\u505C\u6B62\uFF1Bunknown \u4E0D\u7B49\u4E8E\u56DE\u6EDA\u3002Job \u5EFA\u8BAE\u987B\u7531\u539F owner \u663E\u5F0F\u8C03\u7528\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u6536\u96C6\u6216\u505C\u6B62\u3002";
export declare const RUNTIME_CANCEL_DESCRIPTION = "\u8BF7\u6C42\u53D6\u6D88\u6307\u5B9A\u8FD0\u884C\uFF1A\u505C\u6B62\u8C03\u5EA6\u3001\u5411\u540E\u53D1\u6B65\u9AA4\u4F20\u64AD\u53D6\u6D88\uFF1B\u5DF2\u5F00\u59CB\u7684\u526F\u4F5C\u7528\u6B65\u9AA4\u72B6\u6001\u53EF\u80FD\u4E3A unknown\u3002";
export declare const RUNTIME_RESUME_DESCRIPTION = "\u663E\u5F0F\u6062\u590D interrupted \u8FD0\u884C\uFF1A\u4FDD\u7559\u5DF2\u4FDD\u5B58\u6210\u529F\u6B65\u9AA4\uFF0C\u53EA\u8BFB\u5728\u9014\u6B65\u9AA4\u91CD\u6392\uFF1B\u82E5\u5B58\u5728\u672A\u77E5\u526F\u4F5C\u7528\uFF0C\u6807\u8BB0 failed/RUNTIME_INTERRUPTED \u5E76\u505C\u6B62\u6574\u4E2A\u6062\u590D\u8BA1\u5212\uFF0C\u4E0D\u81EA\u52A8\u91CD\u53D1\u3002";
export declare const RUNTIME_INSTRUCTIONS = "\u8427\u4F55\u58F0\u660E\u5F0F\u8FD0\u884C\u65F6\uFF1A\u5F53\u4EFB\u52A1\u80FD\u5199\u6210\u7A33\u5B9A\u7684 DAG\uFF08\u8BFB\u53D6/\u641C\u7D22/\u7F16\u8F91/\u5199\u5165/\u547D\u4EE4\uFF0C\u6B65\u9AA4\u95F4\u6709\u660E\u786E\u4F9D\u8D56\uFF09\u65F6\uFF0C\u7528 runtime_run \u63D0\u4EA4\u8BA1\u5212\uFF0C\u800C\u4E0D\u662F\u5728 run_code \u91CC\u5199\u5FAA\u73AF\u6216\u53CD\u590D\u7B49\u5F85\u3002\u72EC\u7ACB\u6B65\u9AA4\u6309\u6279\u6B21\u5E76\u884C\uFF1B\u53EA\u8BFB\u666E\u901A\u5931\u8D25\u53EF retry\uFF0C\u8D85\u65F6\u4E0D\u91CD\u8BD5\uFF1Bdepends_on \u4EC5\u7EA6\u675F\u987A\u5E8F\uFF0C\u4E0D\u6CE8\u5165\u7ED3\u679C\uFF1Bpwsh \u7981\u6B62\u663E\u5F0F\u540E\u53F0\uFF0C\u81EA\u52A8\u8F6C\u540E\u53F0\u9700\u53D6 jobId \u7528\u539F\u751F Job \u5DE5\u5177\u6536\u96C6\u4E14\u4E0B\u6E38\u4E0D\u6267\u884C\uFF1B\u8FD0\u884C\u8BB0\u5F55\u843D\u76D8\uFF0C\u53EF\u7528 runtime_status/runtime_result/runtime_cancel/runtime_resume\u3002\u526F\u4F5C\u7528\u6B65\u9AA4\u4E0D\u91CD\u8BD5\u3001\u5D29\u6E83\u540E\u5728\u9014\u6B65\u9AA4\u53EF\u80FD unknown\uFF0C\u4E0D\u4FDD\u8BC1 exactly-once\uFF1B\u7B80\u5355\u4E00\u6B21\u6027\u64CD\u4F5C\u4ECD\u7528\u539F\u5DE5\u5177\u6216\u5BBF\u4E3B\u540E\u53F0 Job\uFF0C\u4E0D\u8981\u4E3A\u5305\u88C5\u800C\u5305\u88C5\u3002";
