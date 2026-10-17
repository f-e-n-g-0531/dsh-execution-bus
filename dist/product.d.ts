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
/** request 的 {handler,input} 判别联合；控制消息为空对象。 */
export declare const PAYLOAD_SCHEMA: {
    readonly description: "request 必须匹配某个 Handler 的 {handler,input}；status/result/cancel 的 payload 必须为空对象 {}。";
    readonly oneOf: readonly [...{
        type: "object";
        additionalProperties: false;
        required: string[];
        properties: {
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
        readonly properties: {};
    }];
};
export declare const REQUEST_PARAMETERS: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["protocolVersion", "messageId", "requestId", "type", "payload"];
    readonly properties: {
        readonly protocolVersion: {
            readonly type: "integer";
            readonly const: 1;
        };
        readonly messageId: {
            readonly type: "string";
            readonly description: "Unique id of this message; reuse only when redelivering the same message.";
        };
        readonly requestId: {
            readonly type: "string";
            readonly description: "Stable id of one logical operation; reuse it when the same operation is submitted again.";
        };
        readonly type: {
            readonly type: "string";
            readonly enum: readonly ["request", "status", "result", "cancel"];
            readonly description: "request submits work; status/result read the saved snapshot; cancel requests cancellation.";
        };
        readonly payload: {
            readonly description: "request 必须匹配某个 Handler 的 {handler,input}；status/result/cancel 的 payload 必须为空对象 {}。";
            readonly oneOf: readonly [...{
                type: "object";
                additionalProperties: false;
                required: string[];
                properties: {
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
                readonly properties: {};
            }];
        };
    };
};
export declare const STATE_PARAMETERS: {
    readonly type: "object";
    readonly properties: {};
    readonly additionalProperties: false;
};
export declare const REQUEST_DESCRIPTION = "\u8427\u4F55 / Xiao He. Submit a version 1 request and WAIT for its terminal result in this tool call. Use only when a host operation is expected to exceed ~30s, may be retried as the same logical operation (reuse requestId), must outlive a run_code budget end, or several steps must await one execution; otherwise call the original tool directly. messageId is per message; requestId is per logical operation. Control status/result/cancel use an empty payload; their snapshot is read-only. A PTC program end (including run_code budget expiry) only stops waiting: accepted work continues and the same requestId can be retrieved with status/result or cancelled. Diagnostic handler only: test {delayMs:0..30000,fail:boolean}; never use it to perform real work. Acceptance is volatile, not success. No polling or restart resume.";
export declare const MODE_INSTRUCTIONS: string;
