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
        };
        readonly requestId: {
            readonly type: "string";
        };
        readonly type: {
            readonly type: "string";
            readonly enum: readonly ["request", "status", "result", "cancel"];
        };
        readonly payload: {
            readonly type: "object";
        };
    };
};
export declare const STATE_PARAMETERS: {
    readonly type: "object";
    readonly properties: {};
    readonly additionalProperties: false;
};
export declare const REQUEST_DESCRIPTION = "\u8427\u4F55 / Xiao He. Submit a version 1 request and WAIT for its terminal result in this tool call. Reuse requestId only for the same logical operation. Business handlers: host.read {file_path,offset?,limit?<=100}, host.glob {pattern,path?}, host.grep {pattern,path?,include?} (read-only, terminal reuse allowed); host.edit {file_path,old_string,new_string,replace_all?}, host.write {file_path,content}, host.pwsh {description,command,timeoutMs?,workdir?,run_in_background?,sandbox_permissions?,justification?} (mutating, terminal reuse denied). Diagnostic handler only: test {delayMs:0..30000,fail:boolean}; never use it to perform real work. Control status/result/cancel use empty payload. Acceptance is volatile, not success. No polling or restart resume.";
export declare const MODE_INSTRUCTIONS: string;
