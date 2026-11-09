/** Cooperative local-process exclusion, not a sandbox or distributed lease.
 * Never steals a lock: even a dead PID or old timestamp requires operator reconciliation. */
export declare function acquireRootLock(root: string): () => void;
