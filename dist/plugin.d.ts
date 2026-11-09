import type { Context } from "@deepseek-ai/cordis";
import { RuntimeService } from "./runtime/service.js";
export { RuntimeService };
export { BusinessPromptHistory } from "./runtime/prompt-history.js";
export type { BusinessPromptSnapshot, BusinessPromptHistorySummary, BusinessPromptHistoryRead, BusinessPromptHistorySaveInput, BusinessPromptDefaultChanges } from "./runtime/prompt-history.js";
export type { HandoffSnapshot, HandoffSelection } from "./runtime/handoff.js";
export type { WorkerHostOptions, DelegationPolicyAdapter, } from "./runtime/agent.js";
export type { DependencyContext, DependencyPage, } from "./runtime/dependency-context.js";
export { ModelWaitObserver } from "./runtime/model-wait.js";
export type { ModelWaitEvent, ModelWaitStatus, ModelWaitReason, } from "./runtime/model-wait.js";
export { createBusinessPromptOverrides, previewBusinessPrompt, compareBusinessPrompts, } from "./runtime/prompt-preview.js";
export type { BusinessPromptOverrides, BusinessPromptPreview, } from "./runtime/prompt-preview.js";
export type { CapacitySnapshot } from "./runtime/service.js";
export type { NotificationSender } from "./runtime/notification-delivery.js";
export declare const name = "xiao-he-runtime";
export declare const inject: string[];
/** 声明式运行时插件：只暴露 runtime_* 工具，执行/持久化在 RuntimeService。 */
export declare function apply(ctx: Context): void;
