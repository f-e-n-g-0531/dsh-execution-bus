/** Strict JSON tree validation before serialization, cloning or recursive freezing. */
export declare function assertJson(value: unknown, depth?: number, active?: Set<object>, budget?: {
    left: number;
}): void;
