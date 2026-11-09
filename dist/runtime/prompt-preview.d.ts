/** Offline only. These business defaults are not the live Worker prompt. */
export declare const BUSINESS_PROMPT_DEFAULTS: Readonly<{
    communication: "Communicate concisely, using the task's language. Separate facts from uncertainty.";
    delivery: "Summarize the result, supporting evidence, and remaining limitations.";
}>;
export declare const BUSINESS_PROMPT_MAX_SECTION_BYTES = 8192;
declare const SECTIONS: readonly ["communication", "delivery"];
type Section = (typeof SECTIONS)[number];
export interface BusinessPromptOverride {
    text: string;
    /** SHA-256 of this section's default when the override was authored. Not provenance proof. */
    baseHash: string;
}
export type BusinessPromptOverrides = Partial<Record<Section, BusinessPromptOverride>>;
export interface BusinessPromptPreviewInput {
    overrides?: BusinessPromptOverrides;
    /** Optional optimistic check against the current runtime-owned defaults revision. */
    baseRevision?: string;
}
export interface BusinessPromptPreview {
    kind: "offline_business_prompt_preview";
    applied: false;
    authorized: false;
    executable: false;
    defaultsRevision: string;
    revision: string;
    security: {
        source: "WORKER_ROLE_INSTRUCTIONS";
        text: string;
        hash: string;
    };
    business: Record<Section, {
        text: string;
        source: "default" | "override";
        defaultHash: string;
        baseHash: string;
        drifted: boolean;
    }>;
    overrides: BusinessPromptOverrides;
    /** Inspection text only; never passed to a model by this module. */
    text: string;
    limitations: readonly string[];
}
/** Stamp new overrides against current local defaults. No save/apply/authorization occurs. */
export declare function createBusinessPromptOverrides(raw?: unknown): BusinessPromptOverrides;
/** Pure bounded host API. Custom text is untrusted business data, not a security policy. */
export declare function previewBusinessPrompt(raw?: unknown): BusinessPromptPreview;
/** Compare two supplied configurations under current defaults, not persisted history.
 * baseRevision, if present, must equal the before preview revision (optimistic stale-input guard).
 * Neither preview is applied; drift means an override's supplied base hash differs from today's default.
 */
export declare function compareBusinessPrompts(raw: unknown): {
    kind: "offline_business_prompt_comparison";
    applied: false;
    authorized: false;
    beforeRevision: string;
    afterRevision: string;
    defaultsRevision: string;
    changedSections: Section[];
    baselineChangedSections: Section[];
    driftedSections: {
        before: Section[];
        after: Section[];
    };
};
export {};
