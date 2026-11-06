import type { RunRecord } from "./store.js";
export interface OwnerReviewRecord {
    revision: number;
    snapshotHash: string;
    disposition: "accepted" | "needs_work";
    reason: string;
    at: number;
}
export declare const MAX_OWNER_REVIEWS = 32;
/** Bind every complete successful result, without treating its contents as evidence. */
export declare function reviewSnapshot(run: RunRecord): string | undefined;
/** Owner declaration only: caller identity does not prove human or independent review. */
export declare function ownerReview(run: RunRecord): {
    recordedAt?: number | undefined;
    snapshotHash?: string | undefined;
    revision: number;
    status: "accepted" | "needs_work" | "stale" | "not_recorded";
    verification: "owner_declared_not_independently_verified";
};
/** Validate bounded persisted declarations, not the truth of their reasons. */
export declare function validOwnerReviews(value: unknown, createdAt: number): value is OwnerReviewRecord[];
