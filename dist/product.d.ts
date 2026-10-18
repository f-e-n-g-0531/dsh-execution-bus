/** Stable product identities and policy. Historical IDs are compatibility contracts, not display names. */
export declare const PRODUCT: Readonly<{
    name: "萧何 / Xiao He";
    packageName: "@feng0531/dsh-execution-bus";
    presetId: "execution-bus-test";
    presetRowId: "preset-execution-bus-test";
    modeEntry: "@feng0531/dsh-execution-bus/mode";
    modePluginName: "execution-bus-mode";
}>;
export declare const CORE_DEFAULTS: Readonly<{
    concurrency: 2;
    queueLimit: 32;
    recordLimit: 256;
    resultBytes: 65536;
    retentionMs: 3600000;
}>;
export declare const ADMISSION_DEFAULTS: Readonly<{
    sessionQueueLimit: 16;
    maxQueueWaitMs: 120000;
}>;
export declare const HANDLER_LIMITS: Readonly<{
    readLines: 100;
    readPathChars: 2048;
    diagnosticDelayMs: 30000;
}>;
/** 调度策略：类别优先级 + 等待老化 + 长任务诊断阈值。 */
export declare const SCHEDULER_POLICY: Readonly<{
    longRunningMs: 30000;
    queueAgingMs: 30000;
    queueClassOrder: Readonly<Record<string, number>>;
}>;
export declare const REQUEST_PARAMETERS: {
    readonly oneOf: readonly [...{
        type: "object";
        additionalProperties: false;
        required: string[];
        properties: {
            requestId: {
                readonly type: "string";
            };
            messageId: {
                readonly type: "string";
            };
            handler: {
                type: "string";
                const: "host.read" | "host.glob" | "host.grep" | "host.edit" | "host.write" | "host.pwsh" | "test";
            };
            input: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["delayMs", "fail"];
                readonly properties: {
                    readonly delayMs: {
                        readonly type: "integer";
                        readonly description: "Diagnostic delay in milliseconds (0-30000).";
                    };
                    readonly fail: {
                        readonly type: "boolean";
                        readonly description: "Settle as a controlled failure when true.";
                    };
                };
            } | {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["file_path"];
                readonly properties: {
                    readonly file_path: {
                        readonly type: "string";
                        readonly description: "Path resolved against the session working directory.";
                    };
                    readonly offset: {
                        readonly type: "integer";
                        readonly description: "1-based first line to read.";
                    };
                    readonly limit: {
                        readonly type: "integer";
                        readonly description: "Maximum lines to read (<=100).";
                    };
                };
            } | {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["pattern"];
                readonly properties: {
                    readonly pattern: {
                        readonly type: "string";
                        readonly description: "Glob pattern; a bare pattern matches basenames at any depth.";
                    };
                    readonly path: {
                        readonly type: "string";
                        readonly description: "Directory to search; defaults to the session working directory.";
                    };
                };
            } | {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["pattern"];
                readonly properties: {
                    readonly pattern: {
                        readonly type: "string";
                        readonly description: "Ripgrep regular expression.";
                    };
                    readonly path: {
                        readonly type: "string";
                        readonly description: "File or directory to search; defaults to the session working directory.";
                    };
                    readonly include: {
                        readonly type: "string";
                        readonly description: "One positive glob filter; negation and comma lists are rejected.";
                    };
                };
            } | {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["file_path", "old_string", "new_string"];
                readonly properties: {
                    readonly file_path: {
                        readonly type: "string";
                        readonly description: "File to edit.";
                    };
                    readonly old_string: {
                        readonly type: "string";
                        readonly description: "Literal text to replace.";
                    };
                    readonly new_string: {
                        readonly type: "string";
                        readonly description: "Replacement text.";
                    };
                    readonly replace_all: {
                        readonly type: "boolean";
                        readonly description: "Replace every occurrence.";
                    };
                };
            } | {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["file_path", "content"];
                readonly properties: {
                    readonly file_path: {
                        readonly type: "string";
                        readonly description: "File to write.";
                    };
                    readonly content: {
                        readonly type: "string";
                        readonly description: "Full file content.";
                    };
                };
            } | {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["description", "command"];
                readonly properties: {
                    readonly description: {
                        readonly type: "string";
                        readonly description: "Clear, concise description of what the command does (shown in the UI).";
                    };
                    readonly command: {
                        readonly type: "string";
                        readonly description: "PowerShell command to execute.";
                    };
                    readonly timeoutMs: {
                        readonly type: "number";
                        readonly description: "Positive timeout in milliseconds.";
                    };
                    readonly workdir: {
                        readonly type: "string";
                        readonly description: "Working directory; defaults to the session working directory.";
                    };
                    readonly run_in_background: {
                        readonly type: "boolean";
                        readonly description: "Return a host Job id immediately instead of waiting.";
                    };
                    readonly sandbox_permissions: {
                        readonly type: "string";
                        readonly enum: readonly ["workspace-write", "danger-full-access"];
                        readonly description: "Narrowest wider sandbox mode; must be paired with justification.";
                    };
                    readonly justification: {
                        readonly type: "string";
                        readonly description: "Required with sandbox_permissions; one sentence of reason.";
                    };
                };
            };
        };
    }[], {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly required: readonly ["requestId", "type"];
        readonly properties: {
            readonly requestId: {
                readonly type: "string";
            };
            readonly messageId: {
                readonly type: "string";
            };
            readonly type: {
                readonly type: "string";
                readonly enum: readonly ["status", "result", "cancel"];
                readonly description: "Read the saved snapshot or request cancellation for this requestId.";
            };
        };
    }];
};
export declare const STATE_PARAMETERS: {
    readonly type: "object";
    readonly properties: {};
    readonly additionalProperties: false;
};
export declare const REQUEST_DESCRIPTION = "\u8427\u4F55 / Xiao He. Submit a request and WAIT for its terminal snapshot; the simplified call takes {requestId, handler, input} (messageId optional) and control calls take {requestId, type:\"status\"|\"result\"|\"cancel\"}. Use only when coordination helps: the same logical operation may be retried or deduplicated (reuse requestId), work must outlive a run_code budget end, or multiple steps must await one execution. Duration alone is not a reason \u2014 for a one-off long command use the original tool or its background Job. A PTC program end only stops waiting: accepted work continues and the same requestId can be retrieved with type:\"result\" or cancelled. Do not poll status inside the same run_code program as an unfinished request: end that program and retrieve in a later step. The snapshot may contain reused:true when this call attached to an existing execution. The full v1 envelope is still accepted. Diagnostic handler only: test {delayMs:0..30000,fail:boolean}; never use it for real work. Acceptance is volatile, not success. No polling or restart resume.";
export declare const MODE_INSTRUCTIONS: string;
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
                                readonly description: "宿主工具参数，按工具 schema 校验";
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
            readonly description: "可选：指定运行 ID；省略时列出最近运行";
        };
    };
    readonly additionalProperties: false;
};
export declare const RUNTIME_STATE_PARAMETERS: {
    readonly type: "object";
    readonly properties: {};
    readonly additionalProperties: false;
};
export declare const RUNTIME_RUN_DESCRIPTION = "\u8427\u4F55\u58F0\u660E\u5F0F\u8FD0\u884C\u65F6\uFF1A\u63D0\u4EA4 DAG \u8BA1\u5212\uFF08steps\uFF1Aid/tool/input/depends_on/retry/timeout_ms\uFF09\uFF0C\u7531\u7A0B\u5E8F\u6309\u4F9D\u8D56\u5E76\u884C\u6267\u884C\u3001\u5BF9\u53EA\u8BFB\u6B65\u9AA4\u91CD\u8BD5\u3001\u9010\u6B65\u843D\u76D8\u3002\u9ED8\u8BA4\u7B49\u5F85\u5B8C\u6210\u8FD4\u56DE\u6B65\u9AA4\u72B6\u6001\uFF1Basync:true \u7ACB\u5373\u8FD4\u56DE runId\uFF0C\u7528 runtime_status/runtime_result \u53D6\u56DE\uFF0Cruntime_cancel \u53D6\u6D88\u3002\u4EC5\u5141\u8BB8 read/glob/grep/edit/write/pwsh\uFF1B\u526F\u4F5C\u7528\u6B65\u9AA4\u4E0D\u91CD\u8BD5\u3001\u5D29\u6E83\u540E\u5728\u9014\u6B65\u9AA4\u6807\u8BB0 unknown\uFF08\u4E0D\u505A exactly-once \u56DE\u6EDA\uFF09\u3002\u7B80\u5355\u4E00\u6B21\u8C03\u7528\u8BF7\u76F4\u63A5\u7528\u539F\u5DE5\u5177\u3002";
export declare const RUNTIME_STATUS_DESCRIPTION = "\u8BFB\u53D6\u672C\u4F1A\u8BDD\u7684\u8FD0\u884C\u5143\u6570\u636E\uFF1A\u4E0D\u5E26 runId \u5217\u51FA\u6700\u8FD1\u8FD0\u884C\uFF0C\u5E26 runId \u8FD4\u56DE\u6307\u5B9A\u8FD0\u884C\u4E0E\u6B65\u9AA4\u72B6\u6001\uFF08\u4E0D\u542B\u7ED3\u679C\uFF09\u3002\u4E0D\u8981\u8F6E\u8BE2\u6B63\u5728\u7B49\u5F85\u7684 runtime_run\u3002";
export declare const RUNTIME_RESULT_DESCRIPTION = "\u8BFB\u53D6\u6307\u5B9A\u8FD0\u884C\u5DF2\u4FDD\u5B58\u7684\u6B65\u9AA4\u7ED3\u679C\uFF08\u5355\u6B65\u7ED3\u679C\u8D85\u8FC7 64KiB \u65F6\u53EA\u8FD4\u56DE truncated/bytes \u6807\u8BB0\uFF09\u3002";
export declare const RUNTIME_CANCEL_DESCRIPTION = "\u8BF7\u6C42\u53D6\u6D88\u6307\u5B9A\u8FD0\u884C\uFF1A\u505C\u6B62\u8C03\u5EA6\u3001\u5411\u540E\u53D1\u6B65\u9AA4\u4F20\u64AD\u53D6\u6D88\uFF1B\u5DF2\u5F00\u59CB\u7684\u526F\u4F5C\u7528\u6B65\u9AA4\u72B6\u6001\u53EF\u80FD\u4E3A unknown\u3002";
export declare const RUNTIME_RESUME_DESCRIPTION = "\u6062\u590D interrupted \u8FD0\u884C\uFF1A\u53EA\u8BFB\u6B65\u9AA4\u91CD\u65B0\u6392\u961F\uFF0C\u526F\u4F5C\u7528\u5728\u9014\u6B65\u9AA4\u6807\u8BB0 failed\uFF08RUNTIME_INTERRUPTED\uFF09\uFF1B\u4E0D\u81EA\u52A8\u6267\u884C\uFF0C\u9700\u663E\u5F0F\u8C03\u7528\u3002";
export declare const RUNTIME_INSTRUCTIONS = "\u8427\u4F55\u58F0\u660E\u5F0F\u8FD0\u884C\u65F6\uFF1A\u5F53\u4EFB\u52A1\u80FD\u5199\u6210\u7A33\u5B9A\u7684 DAG\uFF08\u8BFB\u53D6/\u641C\u7D22/\u7F16\u8F91/\u5199\u5165/\u547D\u4EE4\uFF0C\u6B65\u9AA4\u95F4\u6709\u660E\u786E\u4F9D\u8D56\uFF09\u65F6\uFF0C\u7528 runtime_run \u63D0\u4EA4\u8BA1\u5212\uFF0C\u800C\u4E0D\u662F\u5728 run_code \u91CC\u5199\u5FAA\u73AF\u6216\u53CD\u590D\u7B49\u5F85\u3002\u72EC\u7ACB\u6B65\u9AA4\u4F1A\u5E76\u884C\uFF1B\u53EA\u8BFB\u6B65\u9AA4\u53EF retry\uFF1B\u8FD0\u884C\u8BB0\u5F55\u843D\u76D8\uFF0C\u53EF\u7528 runtime_status/runtime_result/runtime_cancel/runtime_resume\u3002\u526F\u4F5C\u7528\u6B65\u9AA4\u4E0D\u91CD\u8BD5\u3001\u5D29\u6E83\u540E\u5728\u9014\u6B65\u9AA4\u53EF\u80FD unknown\uFF0C\u4E0D\u4FDD\u8BC1 exactly-once\uFF1B\u7B80\u5355\u4E00\u6B21\u6027\u64CD\u4F5C\u4ECD\u7528\u539F\u5DE5\u5177\u6216\u5BBF\u4E3B\u540E\u53F0 Job\uFF0C\u4E0D\u8981\u4E3A\u5305\u88C5\u800C\u5305\u88C5\u3002";
