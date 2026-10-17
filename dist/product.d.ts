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
