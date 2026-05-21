# FlashList Web Changes Summary

## Repository

`@shopify/flash-list`

## Two changes across two files

### 1. DOM Sort Fix — `src/recyclerview/ViewHolderCollection.tsx`

Added `import { Platform } from "react-native"` and replaced the `Array.from(renderStack.entries(), mapFn)` single-pass render with a two-step approach: `Array.from(renderStack.entries())` followed by `.sort(([, a], [, b]) => a.index - b.index)` gated behind `Platform.OS === "web"`, then `.map(mapFn)`. This ensures DOM nodes are ordered by data index on web, fixing screen reader reading order, keyboard Tab navigation order, and cross-item text selection (GitHub issue #1839). The original commented-out debug sort block was preserved. On native platforms, behavior is unchanged.

### 2. Stale Hover Fix — `src/recyclerview/ViewHolder.tsx`

Added `Platform` to the `react-native` import and added a new `useLayoutEffect` that watches the `index` prop. When `index` changes (meaning the ViewHolder was recycled to a new data item), it dispatches a synthetic `MouseEvent("mouseleave", { bubbles: false, cancelable: false })` on the ViewHolder's DOM node, gated behind `Platform.OS === "web"`. This fixes stale hover/tooltip states that appear on recycled items during fast scrolling. The root cause: the DOM sort in change #1 causes React to call `insertBefore` to reorder DOM nodes, and browsers do not fire `mouseleave` events for DOM structural moves (only for pointer movement). The synthetic event forces the browser and any JS hover handlers to clear hover state before the frame is painted.

## Key context from investigation

- FlashList uses `position: absolute` with `top`/`left` to position items, decoupling visual position from DOM order.
- The render stack has ~28-33 ViewHolders for a typical list; sorting 30 items costs ~0.003ms (negligible).
- Entries are unsorted ~96% of the time during active scrolling (confirmed via production instrumentation on an 8400-item list).
- The `useLayoutEffect` fires after React commits DOM mutations (including `insertBefore`) but before the browser paints.
- All 183 existing tests pass with both changes.
