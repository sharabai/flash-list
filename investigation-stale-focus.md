# Investigation: Multiple Items Appearing Focused After DOM Sort Fix

## Problem

After applying the FlashList DOM sort fix (sorting `renderStack` entries by index on web), multiple list items can appear with `isFocused = true` simultaneously during fast scrolling.

## Root Cause

The bug is **not** caused by FlashList producing duplicate indices. Indices in the render stack are always unique.

The bug is a pre-existing stale render issue in `ViewHolder.tsx` that was previously invisible because DOM order was randomized.

### The stale `useMemo` in ViewHolder.tsx (line 105-110)

```typescript
const children = useMemo(() => {
    return renderItem?.({ item, index, extraData, target }) ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
}, [item, extraData, target, renderItem]); // <-- index is EXCLUDED
```

`index` is intentionally excluded from the dependency array. When a ViewHolder is recycled (same `item` reference, different `index`), the `children` memo is **not recomputed**. The rendered output still carries the old index value.

### Why this was invisible before the sort fix

Before the fix, DOM order was random (Map insertion order). A ViewHolder carrying a stale `isItemFocused = true` from a previous index would be positioned at an unrelated place in the DOM. The user wouldn't see two focused items because the stale one was effectively hidden by the random positioning.

After the fix, DOM order matches visual order. A stale focus highlight now appears in its correct visual position, making it visible to the user.

### Reproduction scenario (fast scroll)

1. ViewHolder key "A" renders item at index 50 with `focusedIndex = 50` → `isItemFocused = true`
2. Fast scroll triggers recycling
3. Key "A" is reassigned to index 12 (new data item)
4. If the `item` reference is the same (or structurally identical), `useMemo` skips recomputation
5. The rendered output for key "A" still shows `isItemFocused = true` (stale, from when index was 50)
6. The actual item at index 50 (now key "B") also renders with `isItemFocused = true`
7. Result: two items visually appear focused

## Evidence: FlashList indices are always unique

- `RenderStackManager.sync()` processes `engagedIndices` which is a `ConsecutiveNumbers` range — each index appears exactly once
- `syncItem()` assigns one index to one key; no two keys can share an index after a sync
- The DOM sort only reorders entries — it does not modify any index values

## Possible fixes

### Option A: Include `focusedIndex` in FlashList's `extraData` (consumer-side fix)

```tsx
<FlashList
    extraData={focusedIndex}  // or combine: [flattenedData.length, focusedIndex]
    ...
/>
```

When `focusedIndex` changes, `extraData` changes, which is in the `useMemo` dependency array. This forces all ViewHolders to recompute their `children`, picking up the new `isItemFocused` value.

**Tradeoff:** Every `focusedIndex` change re-renders all visible items. For arrow-key navigation this means ~30 items re-render on each keystroke.

### Option B: Add `index` to the `useMemo` dependency array (FlashList-side fix)

```typescript
const children = useMemo(() => {
    return renderItem?.({ item, index, extraData, target }) ?? null;
}, [item, index, extraData, target, renderItem]);
```

This ensures `children` is recomputed whenever the ViewHolder is recycled to a new index.

**Tradeoff:** The comment in FlashList says "We don't really need to re-render the children when the index changes" — this was a deliberate performance optimization. Adding `index` back means recycled items always re-render their children, which slightly increases render cost during scrolling.

### Option C: Use `keyExtractor` that changes with focus (consumer-side workaround)

Not recommended — would break recycling entirely.

## Recommendation

**Option A** is the safest immediate fix for consumers. It doesn't require changes to FlashList and gives the consumer control over when re-renders happen.

**Option B** is the correct long-term fix in FlashList. The `useMemo` optimization that excludes `index` is fragile — any `renderItem` that uses `index` (which is very common) can produce stale output after recycling.
