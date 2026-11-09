import { BUSINESS_PROMPT_DEFAULTS, type BusinessPromptOverrides } from "./prompt-preview.js";
interface OfflineOnly {
    applied: false;
    authorized: false;
    executable: false;
}
type BusinessSection = keyof typeof BUSINESS_PROMPT_DEFAULTS;
type BusinessDefaults = Record<BusinessSection, {
    text: string;
    hash: string;
}>;
interface StoredSnapshot {
    revision: number;
    previousRevision: number | null;
    savedAt: number;
    source: string;
    defaultsRevision: string;
    overrides: BusinessPromptOverrides;
    /** Locally observed defaults only; hashes are not trusted provenance. */
    businessDefaults?: BusinessDefaults;
    previewRevision: string;
}
export interface BusinessPromptSnapshot extends StoredSnapshot, OfflineOnly {
}
export interface BusinessPromptHistorySummary extends Omit<StoredSnapshot, "overrides" | "businessDefaults">, OfflineOnly {
}
export interface BusinessPromptDefaultChanges extends OfflineOnly {
    revision: number;
    items: {
        section: BusinessSection;
        baseHash: string | null;
        currentHash: string;
        status: "known" | "unknown";
        drifted: boolean | null;
        previousText?: string;
        currentText: string;
    }[];
}
export interface BusinessPromptHistoryRead extends OfflineOnly {
    revision: number;
    /** Newest first. Empty history has revision zero. */
    items: BusinessPromptHistorySummary[];
}
export interface BusinessPromptHistorySaveInput {
    expectedRevision: number;
    source: string;
    overrides: BusinessPromptOverrides;
}
/** Host-only local persistence. No model tools, live Worker wiring, apply or authorization.
 * root must be a private host-owned directory: this cooperative lock is not a sandbox.
 * Crash/stale locks are never stolen; reconcile them offline with all writers stopped.
 * Stores original defaultsRevision, supplied override baseHash and observed business
 * defaults, never security text. Legacy records without defaults remain readable.
 * Local files/hashes are not trusted provenance or full prompt reproduction.
 * Reading old records never requires today's defaults hash.
 * A failed save may have committed before cleanup failed; reread before retrying CAS.
 */
export declare class BusinessPromptHistory {
    private readonly target;
    private readonly lock;
    constructor(root: string);
    read(): BusinessPromptHistoryRead;
    history(): BusinessPromptHistorySummary[];
    get(revision: number): BusinessPromptSnapshot;
    /** Offline before/current data, not an apply operation or a provenance claim.
     * Lookup is section-specific by the supplied baseline hash, not defaultsRevision.
     * Legacy records cannot claim an observed baseline, even if today happens to match.
     */
    defaultChanges(revision: number): BusinessPromptDefaultChanges;
    save(raw: BusinessPromptHistorySaveInput): BusinessPromptSnapshot;
    private locked;
    private load;
    private persist;
}
export {};
