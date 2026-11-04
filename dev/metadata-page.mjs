/** Pure development prototype, NOT connected to RunStore. Input is trusted validated metadata. */
export function compareMetadata(a, b) {
  return b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId);
}
export function selectMetadataPage(
  entries,
  { limit = 20, offset = 0, ownerSessionId } = {},
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw Error("INVALID_PAGE");
  const end = Math.min(Number.MAX_SAFE_INTEGER, offset + limit);
  let comparisons = 0,
    matched = 0,
    peakEntries = 0;
  const compare = (a, b) => {
    comparisons++;
    return compareMetadata(a.entry, b.entry) || a.index - b.index;
  };
  // Array input is already materialized; this prototype bounds only selection storage.
  const mode = end >= entries.length ? "full-sort" : "heap";
  const heap = [];
  const down = () => {
    let parent = 0;
    for (;;) {
      let child = parent * 2 + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0)
        child++;
      if (compare(heap[parent], heap[child]) >= 0) break;
      [heap[parent], heap[child]] = [heap[child], heap[parent]];
      parent = child;
    }
  };
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (ownerSessionId !== undefined && entry.ownerSessionId !== ownerSessionId)
      continue;
    matched++;
    if (limit === 0) continue;
    const item = { entry, index };
    if (mode === "full-sort") heap.push(item);
    else if (heap.length < end) {
      heap.push(item);
      let child = heap.length - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (compare(heap[parent], heap[child]) >= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
    } else if (compare(item, heap[0]) < 0) {
      heap[0] = item;
      down();
    }
    peakEntries = Math.max(peakEntries, heap.length);
  }
  heap.sort(compare);
  return {
    page: heap.slice(offset, end).map((x) => x.entry),
    comparisons,
    matched,
    peakEntries,
    mode,
  };
}
