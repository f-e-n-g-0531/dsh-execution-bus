/** Bounded process-local membership snapshots, not frozen run states or authorization. */
export declare class HistoryPages {
    private readonly snapshots;
    page(owner: string, task: string | undefined, input: Record<string, unknown>, capture: () => string[]): {
        ids: string[];
        offset: number;
        limit: number;
        hasMore: boolean;
        pagination: {
            nextCursor?: string | undefined;
            mode: "snapshot";
            capturedAt: number;
            expiresAt: number;
            total: number;
            missingRunIds: string[];
        };
    };
    clear(): void;
}
