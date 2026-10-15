/** Strict JSON tree validation before serialization, cloning or recursive freezing. */
export function assertJson(value, depth = 0, active = new Set(), budget = { left: 65536 }) {
    if (--budget.left < 0 || depth > 64)
        throw Error("JSON_LIMIT");
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return;
    if (typeof value === "number" &&
        Number.isFinite(value) &&
        !Object.is(value, -0))
        return;
    if (typeof value !== "object" || value === null)
        throw Error("INVALID_JSON");
    if (active.has(value))
        throw Error("CYCLIC_JSON");
    const array = Array.isArray(value);
    if (!array &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
        throw Error("INVALID_JSON_OBJECT");
    active.add(value);
    try {
        const keys = Reflect.ownKeys(value);
        if (array && keys.length !== value.length + 1)
            throw Error("INVALID_JSON_ARRAY");
        for (const key of keys) {
            if (array && key === "length")
                continue;
            if (typeof key !== "string")
                throw Error("INVALID_JSON_KEY");
            if (array &&
                (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
                throw Error("INVALID_JSON_ARRAY");
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor.enumerable || !("value" in descriptor))
                throw Error("INVALID_JSON_PROPERTY");
            assertJson(descriptor.value, depth + 1, active, budget);
        }
    }
    finally {
        active.delete(value);
    }
}
