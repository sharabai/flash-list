# Web Scroll Freeze Fix — Programmatic Scroll vs. Patch-007 Sort

> **Status:** implemented. See §6 for the per-file changes with line citations to the live source.
>
> **Scope:** internal to `@shopify/flash-list`. No public API change. No new DOM listeners. No new timers. Preserves smooth scrolling on web. Keeps patch-007's Tab-navigation semantics intact.
>
> **Subsequent evolution:** the `focusin`-listener / sort-decision layer described here was later reworked. The `refHolder`-based focused-row lookup, `TAB_SCROLL_THRESHOLD_MS`, and the single `maybeDoSort` wrapper have been replaced by a `data-flashlist-index` DOM marker, two new filter booleans (`isSameLogicalRow` with depth tracking, `isPhantomMutationFocus`), and split `maybeDoSortOnFocus` / `maybeDoSortOnScroll` paths. See [viewholder-marker-and-focus-filter.md](viewholder-marker-and-focus-filter.md) for the current design. The sort-deferral machinery described below (programmatic-scroll gating, `runAfterProgrammaticScroll`, `notifyProgrammaticScrollSettled`, `VelocityTracker`-driven `isMomentumEnd`) is unchanged and still in effect.

---

## 0. TL;DR

When a user arrow-navigates a focused row in a `FlashList` on **web**, every press calls `listRef.scrollToIndex({ index })`. That lowers to a browser-native smooth-scroll animation (`element.scroll({ top, behavior: 'smooth' })`). Patch 007's "fast-track" sort effect inside `ViewHolderCollection` then commits a `setSortId` re-render mid-animation. Because a focused row is a descendant of the scroll container, React's commit phase runs `restoreSelection`, which writes `scrollTop` back to its pre-mutation value. Per CSSOM, writing `scrollTop` cancels any in-flight smooth scroll. The animation freezes part-way to its target.

The fix defers the React commit half of `doSort` (the part that triggers `insertBefore`) until the smooth scroll has truly settled. We piggy-back on FlashList's existing `isMomentumEnd` signal — fired by `VelocityTracker` ~100 ms after the last scroll event — instead of inventing new DOM listeners or new timers.

```
arrow press ─► scrollToIndex ─► [in-flight smooth scroll]
                                   │
                                   ├─ focusin / sort-effect fires
                                   ├─ isScrollingProgrammatically() === true
                                   └─ stash doSort in pendingAfterScrollRef
                                   │           ░░░░░░░ animation continues ░░░░░░░
                                   │
                          last scroll event
                          + 100 ms VelocityTracker debounce
                                   │
                                   ▼
                           isMomentumEnd: true
                                   │
                          notifyProgrammaticScrollSettled()
                                   │
                          drain pendingAfterScrollRef → doSort()
                                   │
                          insertBefore + restoreSelection write scrollTop —
                          but we are no longer animating, so no cancellation
```

**The fix introduces:**

- Two new refs in the controller (`useRecyclerViewController.tsx`):
  - `isProgrammaticScrollActive` — set at `scrollToIndex` entry, cleared exactly once when `isMomentumEnd` fires. Strictly tracks programmatic-scroll state, independent of `pauseOffsetCorrection`.
  - `pendingAfterScrollRef` — single-slot callback pointer (overwritten on repeat).
- Three new methods returned by the controller:
  - `isScrollingProgrammatically(): boolean` — am I in a programmatic scroll right now?
  - `runAfterProgrammaticScroll(cb): void` — stash `cb`; run when the scroll settles.
  - `notifyProgrammaticScrollSettled(): void` — invoked by `RecyclerView.onScrollHandler` from the existing `isMomentumEnd` branch; clears the gate and drains the pending callback.
- The first two are forwarded as **props** from `RecyclerView` directly to its child `ViewHolderCollection` (no public-context widening, no nested-context forwarding).
- One new helper in `ViewHolderCollection.tsx`:
  - `maybeDoSort()` — wraps `doSort()` and defers it via `runAfterProgrammaticScroll` when `isScrollingProgrammatically()` is true.

That's it. No new public API. No change to `FlashListContext`. No new DOM listeners. No new timers.

---

## 1. Symptom

- On web, click a list row (blue focus outline appears), then hold/press arrow-down.
- Scroll **starts moving then freezes** part-way to the target row.
- Bug only appears once items above the viewport start being **recycled** (so the first 5–8 presses from the very top often work; from the middle of a long list it reproduces immediately).
- The longer the per-press scroll distance, the more visible the freeze.

**Behaviors that do _not_ reproduce the bug:**

| Scenario | Why it doesn't freeze |
| --- | --- |
| Arrow keys with focus in a search input outside the list | Focused element is the input, not a list descendant. React's `restoreSelection` saves/restores `scrollTop` of the input's scrollable ancestors, not ours. |
| Tab key navigation through rows | Tab doesn't go through `scrollToIndex`. Browser's native `scrollIntoView` is synchronous (instant), so there's no in-flight smooth scroll to cancel. |
| Early arrow presses at the top of the list | `renderEntriesRef` is still already-sorted (no recycling has shuffled the array order yet). `doSort` short-circuits at `isSorted` → no `setSortId` → no commit → no `restoreSelection`. |

## 2. The setup — what patch-007 does and why

`@shopify+flash-list+2.3.0+007+sort-for-natural-DOM-order.patch` exists because FlashList positions items with `position: absolute`. Visual order is determined by CSS `top`/`left` — **DOM order is independent**. On web that breaks three things:

1. Screen reader reading order follows DOM order, not visual order.
2. Tab navigation follows DOM order — focus jumps unpredictably.
3. Cross-item text selection follows DOM order — selections come out scrambled.

Patch 007 fixes this by sorting `renderEntriesRef` so DOM order matches visual order. To minimize work, it splits the sort into two paths:

- **Deferred sort** (`SORT_DELAY_MS = 1000`): after scrolling pauses, a `setTimeout` reorders the ref and triggers `setSortId`, which causes React to emit `insertBefore` on the changed children. This is the only moment FlashList intentionally reorders the DOM during normal use.
- **Fast-track immediate sort** (`TAB_SCROLL_THRESHOLD_MS = 400`): a `focusin` listener on the container plus a sort-effect branch run `doSort` synchronously when focus is recent. This is **deliberate** — it guarantees Tab navigation always finds the next focusable element in the correct DOM order, without waiting 1 second for the deferred path.

The fast-track is what collides with `scrollToIndex`. Both paths are still needed; we don't want to disable the fast-track or move it back to a delay. We just want to keep its commit out of the smooth-scroll window.

## 3. The kill chain — why a sort cancels a smooth scroll

```
                User presses ArrowDown
                          │
                          ▼
                listRef.scrollToIndex({ index })
                          │
                          ▼      (lowered by RN-Web)
                element.scroll({ top: N, behavior: "smooth" })
                          │
                          ▼      ░░░░░░░░░ browser animation begins ░░░░░░░░░
                          │
                          │   ─ scroll event ticks fire every ~16 ms ─
                          │   ─ each tick re-renders RecyclerView    ─
                          │   ─ ViewHolderCollection sort-effect re-runs ─
                          │
                          ▼
                isRecentFocus === true   →   doSort()
                          │
                          ▼
                renderEntriesRef.sort(byIndex)
                          │
                          ▼
                setSortId(prev => prev + 1)   ← React state update
                          │
                          ▼
                React re-render → React commit
                          │
                          ▼
                React inserts/moves DOM children via insertBefore
                          │
                          ▼      (React's commit pipeline)
                getSelectionInformation()  →  saves activeElement
                                              + scrollTop / scrollLeft
                                                of all scrollable ancestors
                          │
                          ▼      (mutations applied)
                restoreSelection()        →  activeElement.focus()
                                              + ancestor.scrollTop = saved
                                              + ancestor.scrollLeft = saved
                          │
                          ▼      (per CSSOM-View §7.3)
                writing scrollTop = N performs an INSTANT scroll
                → cancels any in-flight smooth-scroll animation
                          │
                          ▼
                Animation freezes at intermediate offset 💥
```

Why this only triggers when a row is focused: `restoreSelection` only writes `scrollTop` on **ancestors of `document.activeElement`**. With focus on a list row, the FlashList scroll container is one such ancestor and gets clobbered. With focus on an outside search input, the scroll container is not an ancestor of the input, so the write goes to a different element (or none) and our scroll survives. With Tab, there is no smooth animation in flight to cancel.

Why this only triggers after recycling kicks in: before recycling, `renderEntriesRef` is naturally sorted by index (items are appended in order during initial layout). `doSort` returns at the `isSorted` short-circuit and never calls `setSortId`. After recycling, the ref's array order diverges from `index` order, so `doSort` actually reorders and commits — that's the commit that gets caught in the kill chain.

This is documented in detail with stack-trace evidence in earlier debug runs (the first `proto_focus_in_commit` and `proto_set_scrollTop` originated from React's `flushMutationEffects` → `restoreSelection`, and their counts aligned 1:1 with `proto_set_scrollLeft` — a textbook selection-preservation signature).

## 4. False trail — the existing 200/300 ms timer is **not** a scroll-end signal

The first instinct (and the first attempted fix) was to defer `doSort` until the existing `setTimeout(animated ? 300 : 200)` fires inside `finishScrollToIndex`. That fails for long-distance scrolls. Here is why.

`scrollToIndex` is structured in four phases:

```
                  ┌─────────────────────────────────────────────┐
                  │  Phase A — synchronous setup at entry        │
                  │  • pauseOffsetCorrection.current = true      │
                  │  • setOffsetProjectionEnabled(false)         │
                  │  • isProgrammaticScrollActive.current = true │  (added by this fix)
                  └────────────────┬────────────────────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────────────────┐
                  │  Phase B — JS pre-materialization (5 steps)  │
                  │  performScrollStep(0..4)                     │
                  │   • updateScrollOffsetWithCallback           │
                  │   • setRenderId — re-renders                 │
                  │   • measure layout / engage indices          │
                  │   • recurse to next step                     │
                  │  Total wall-clock: ~50 ms typical            │
                  └────────────────┬────────────────────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────────────────┐
                  │  Phase C — final native scroll               │
                  │  finishScrollToIndex()                       │
                  │   • scrollViewRef.scrollTo({y, animated})    │ ← browser smooth scroll begins
                  │   • setTimeout(animated ? 300 : 200, …)      │ ← THE 300 ms TIMER
                  └─────────────────────────────────────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────────────────┐
                  │  Phase D — settle (timer fires)              │
                  │  • pauseOffsetCorrection.current = false     │
                  │  • setOffsetProjectionEnabled(true)          │
                  │  • resolve()                                  │
                  └─────────────────────────────────────────────┘
```

The 300 ms timer is **independent of the actual scroll distance**:

```
scroll distance  →   100 px       500 px      2000 px      10000 px
browser smooth time  ~150 ms     ~400 ms     ~800 ms      ~1300 ms
FlashList timer     →  300 ms     300 ms      300 ms        300 ms     ← constant
                       ✅ over    ✅ ~match   ❌ short      ❌ short
                       by 150 ms  on time     by 500 ms     by 1 s
```

It is a heuristic for **FlashList's own self-quiescing internal consumers** — `pauseOffsetCorrection` and `setOffsetProjectionEnabled`. Those happen to be tolerant of the timer firing early because their downstream effects only run in response to ongoing `scroll` events, and once the animation ends, those events stop. So even if the flag clears 500 ms early on a long scroll, nothing observable happens — the consumers self-quiesce.

A non-self-quiescing consumer like our deferred `doSort` cannot be hitched to that timer. Once we register a callback, somebody must invoke it; if the timer fires mid-animation, our drain commits `insertBefore` mid-animation, and the kill chain in §3 cancels the scroll.

| Consumer | What happens if the flag clears too early? |
| --- | --- |
| `applyOffsetCorrection` (gated by `pauseOffsetCorrection`) | A structural property of the per-call timer is that the flag flips back independently of whether a newer programmatic scroll is still in flight. In practice this is masked: the inner branch also requires `diff !== 0` (data must have changed), and during pure-offset programmatic scrolls `diff === 0` short-circuits it to a no-op. |
| `setOffsetProjectionEnabled` (velocity-based projection) | Engaged-window decisions get biased by ~1–2 frames. Recovers within 1–2 frames. |
| **Our deferred `doSort` drain** | **Immediately cancels the in-flight smooth scroll. Visible freeze.** |

Conclusion: the timer is a reasonable heuristic for what FlashList already uses it for; we just can't repurpose it.

## 5. The right signal — `isMomentumEnd`

FlashList already has accurate scroll-end detection. In `helpers/VelocityTracker.ts`, `computeVelocity` debounces incoming `scroll` events with a 100 ms timer. When no `scroll` events arrive for 100 ms, it fires `isMomentumEnd: true` exactly once. `RecyclerView.tsx` already reads this signal in `onScrollHandler` for its own anchor-recompute and velocity-reset.

Three properties make `isMomentumEnd` the right hook for our drain:

1. **Distance-independent.** Whatever the actual animation duration, it always fires ~100 ms after the last paint of the animation.
2. **Naturally robust to overlapping scrolls.** The browser maintains exactly one in-flight smooth scroll per element — a second `element.scroll({behavior:'smooth'})` call **retargets** the existing animation rather than starting a parallel one. Scroll events keep firing across the merged animation; the 100 ms debounce keeps resetting; `isMomentumEnd` fires once at the true end of the merged scroll. So no press-id arithmetic is required, and a single, unguarded clear at `notifyProgrammaticScrollSettled` is correct.
3. **Cross-platform.** `isMomentumEnd` is RN-Web's translation of native scroll events on web and `onMomentumScrollEnd` on native, so the same hook covers iOS / Android.

### 5.1 Verification: `ignoreScrollEvents` cannot suppress the drain

`onScrollHandler` has an early-return guarded by `recyclerViewManager.ignoreScrollEvents`. If that flag were ever true while a programmatic scroll was in flight, scroll events would be dropped before reaching `velocityTracker.computeVelocity`, and `isMomentumEnd` would never fire — the drain would never run.

Grepping the codebase, `ignoreScrollEvents` is written at exactly **one site** (inside `applyOffsetCorrection`). Setting it true requires all of:

1. `getIsFirstLayoutComplete()` is true
2. `hasStableDataKeys()` is true
3. `dataLength > 0`
4. `shouldMaintainVisibleContentPosition()` is true
5. `firstVisibleItemKey.current` is set
6. `currentIndexOfFirstVisibleItem` is found
7. `diff !== 0`
8. **`!pauseOffsetCorrection.current`**
9. `!recyclerViewManager.animationOptimizationsEnabled`
10. **`hasDataChanged`** (`currentDataLength !== lastDataLengthRef.current`)

Conditions 8 and 10 together preclude overlap with `scrollToIndex`:

- During `scrollToIndex`, `pauseOffsetCorrection.current === true` (set at entry). Condition 8 is closed.
- For arrow-key navigation (the reproduction), data length is constant. Condition 10 is also closed.

So `ignoreScrollEvents` cannot be set true during a programmatic scroll, and `isMomentumEnd` is guaranteed to fire when the scroll settles. The drain is reachable.

## 6. Why a parallel `isProgrammaticScrollActive` ref instead of reading `pauseOffsetCorrection`

An earlier sketch read `pauseOffsetCorrection.current` directly from `isScrollingProgrammatically()`. That works for single, well-spaced presses but fails under rapid-hold, because each press's 200/300 ms `setTimeout` clears `pauseOffsetCorrection` on its own schedule — the flag flickers `false` for narrow windows during a held key-repeat. A `doSort` that fires in a flickered-false window commits a `setSortId` immediately and we're back in the kill chain.

The minimal correct fix is to keep `pauseOffsetCorrection` exactly as it is (so its existing FlashList consumers behave identically to today) and add a **separate** ref whose lifetime is what we actually want: `true` from `scrollToIndex` entry until `isMomentumEnd` fires. That's what `isProgrammaticScrollActive` is.

This deliberately leaves `pauseOffsetCorrection`'s existing per-call lifecycle untouched. Two reasons for not changing it here:

1. **Blast-radius isolation.** `pauseOffsetCorrection` gates `applyOffsetCorrection` and `setOffsetProjectionEnabled` — paths whose downstream behavior the community may have come to rely on. Changing its lifetime changes more than this fix needs to.
2. **Scope.** Reasoning about the flag's lifecycle and reasoning about the sort-driven kill chain are independent concerns; mixing them into one change makes both harder to review.

## 7. The fix — code-level changes

All changes live in three files. Cross-references below cite the **current** source. The fix deliberately stays out of the public `FlashListContext` surface and out of `LayoutCommitObserver.tsx` — communication between the controller and its sibling `ViewHolderCollection` happens through the existing parent–child render relationship in `RecyclerView`, via props.

### 7.1 `useRecyclerViewController.tsx` — refs + controller methods + scroll entry

The two new refs:

```53:64:src/recyclerview/hooks/useRecyclerViewController.tsx
  const pauseOffsetCorrection = useRef(false);
  // True for the full duration of an in-flight programmatic scroll
  // (`scrollToIndex` / `scrollToOffset` etc.). Cleared exactly once when the
  // browser-native smooth scroll truly settles, via `notifyProgrammaticScrollSettled`
  // (which `RecyclerView.onScrollHandler` invokes from `isMomentumEnd`).
  // Backs `isScrollingProgrammatically()` so consumers can defer DOM work
  // that would otherwise cancel the in-flight smooth scroll on web (e.g.
  // sort-driven `insertBefore` reorderings).
  const isProgrammaticScrollActive = useRef(false);
  // Holds at most one callback registered via `runAfterProgrammaticScroll`,
  // drained from `notifyProgrammaticScrollSettled`.
  const pendingAfterScrollRef = useRef<(() => void) | null>(null);
```

The three controller methods:

```236:255:src/recyclerview/hooks/useRecyclerViewController.tsx
  const isScrollingProgrammatically = useCallback(
    () => isProgrammaticScrollActive.current,
    []
  );

  const runAfterProgrammaticScroll = useCallback((cb: () => void) => {
    pendingAfterScrollRef.current = cb;
  }, []);

  // Invoked from `RecyclerView.onScrollHandler` inside the existing
  // `isMomentumEnd` branch — the moment FlashList's `VelocityTracker`
  // confirms the browser-native smooth scroll has truly settled (~100ms
  // after the last scroll event). Drains the pending callback registered
  // via `runAfterProgrammaticScroll`, if any.
  const notifyProgrammaticScrollSettled = useCallback(() => {
    isProgrammaticScrollActive.current = false;
    const cb = pendingAfterScrollRef.current;
    pendingAfterScrollRef.current = null;
    cb?.();
  }, []);
```

The flag flip at `scrollToIndex` entry — sits **next to** the existing `pauseOffsetCorrection.current = true`, deliberately leaving that flag's behavior untouched:

```365:374:src/recyclerview/hooks/useRecyclerViewController.tsx
            // Pause the scroll offset adjustments
            pauseOffsetCorrection.current = true;
            recyclerViewManager.setOffsetProjectionEnabled(false);
            // Mark a programmatic scroll as in flight. Cleared in
            // `notifyProgrammaticScrollSettled` when `isMomentumEnd` fires,
            // not by the 200/300 ms timer below — that timer is a fixed
            // heuristic for re-enabling offset correction and unrelated to
            // the actual smooth-scroll completion time.
            isProgrammaticScrollActive.current = true;
```

The existing 200/300 ms `setTimeout` is deliberately left alone — `pauseOffsetCorrection`, `setOffsetProjectionEnabled`, and the promise resolution all keep firing on their original schedule.

### 7.2 `RecyclerView.tsx` — invoke the settle notifier from `isMomentumEnd`; pass props down

The drain trigger:

```284:312:src/recyclerview/RecyclerView.tsx
      velocityTracker.computeVelocity(
        scrollOffset,
        recyclerViewManager.getAbsoluteLastScrollOffset(),
        Boolean(horizontal),
        (velocity, isMomentumEnd) => {
          if (recyclerViewManager.ignoreScrollEvents) {
            return;
          }

          if (isMomentumEnd) {
            // Drain any pending callback registered via
            // `runAfterProgrammaticScroll` BEFORE the early return below
            // so the drain still fires while offset projection is still
            // disabled. This is the moment FlashList's `VelocityTracker`
            // confirms the browser-native smooth scroll has truly settled.
            notifyProgrammaticScrollSettled();

            computeFirstVisibleIndexForOffsetCorrection();
            if (!recyclerViewManager.isOffsetProjectionEnabled) {
              return;
            }
            recyclerViewManager.resetVelocityCompute();
          }
          // Update scroll position and trigger re-render if needed
          if (recyclerViewManager.updateScrollOffset(scrollOffset, velocity)) {
            setRenderId((prev) => prev + 1);
          }
        }
      );
```

The `notifyProgrammaticScrollSettled()` call is intentionally placed **before** the `!isOffsetProjectionEnabled` early return: when the timer hasn't yet flipped projection back on (long scrolls), the drain still fires.

The two new methods are forwarded to `ViewHolderCollection` as ordinary props at the render site, on top of the existing prop list:

```645:650:src/recyclerview/RecyclerView.tsx
            currentStickyIndex={currentStickyIndex}
            hideStickyHeaderRelatedCell={stickyHeaderHideRelatedCell}
            inverted={inverted}
            isScrollingProgrammatically={isScrollingProgrammatically}
            runAfterProgrammaticScroll={runAfterProgrammaticScroll}
          />
```

`RecyclerView`'s own `recyclerViewContext` is **untouched** — the public `FlashListContext` interface is unchanged from upstream, and `LayoutCommitObserver.tsx` keeps its existing seven-method shape. The two new methods are private plumbing between `RecyclerView` and the `ViewHolderCollection` it directly renders.

### 7.3 `ViewHolderCollection.tsx` — accept the props, wrap `doSort` with `maybeDoSort`

The two methods are added to `ViewHolderCollectionProps` and destructured alongside the existing props:

```67:72:src/recyclerview/ViewHolderCollection.tsx
  /** Whether the list is inverted */
  inverted: FlashListProps<TItem>["inverted"];
  /** True while a programmatic scroll (e.g. scrollToIndex) animation is in flight. */
  isScrollingProgrammatically: () => boolean;
  /** Register a callback to run when the current programmatic-scroll animation settles. */
  runAfterProgrammaticScroll: (cb: () => void) => void;
}
```

The wrapper reads them directly — no context lookup, no defensive `?.()` chains:

```210:225:src/recyclerview/ViewHolderCollection.tsx
  // Defers `doSort` while a programmatic scroll animation is in flight.
  // Without this, committing the sort triggers `insertBefore` calls which
  // cause React's selection-preservation logic to write `scrollTop` on the
  // scroll container, cancelling the in-flight smooth scroll animation
  // (the "starts and freezes" bug on web). The deferred call runs once the
  // scroll settles.
  const maybeDoSort = useCallback(() => {
    if (isScrollingProgrammatically()) {
      runAfterProgrammaticScroll(() => {
        doSort();
      });
      return;
    }
    doSort();
  }, [isScrollingProgrammatically, runAfterProgrammaticScroll, doSort]);
```

The two call sites that fire during scroll — the `focusin` listener and the immediate branch of the sort effect — go through the wrapper:

```250:275:src/recyclerview/ViewHolderCollection.tsx
    const onFocusIn = () => {
      lastFocusTimeRef.current = Date.now();
      maybeDoSort();
    };
    container.addEventListener("focusin", onFocusIn);
    return () => container.removeEventListener("focusin", onFocusIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    const isRecentFocus =
      Date.now() - lastFocusTimeRef.current < TAB_SCROLL_THRESHOLD_MS;

    if (isRecentFocus) {
      maybeDoSort();
      return;
    }

    const timeoutId = setTimeout(() => doSort(), SORT_DELAY_MS);
    return () => clearTimeout(timeoutId);
```

The deferred `setTimeout(SORT_DELAY_MS = 1000)` branch is left calling `doSort()` directly — by the time it fires, scrolling has already paused (otherwise `lastFocusTimeRef` would have been updated to `now()` and we'd be in the immediate branch), so there is no in-flight programmatic scroll to fight.

## 8. Behavior matrix — before vs. after

| Scenario | Before fix | After fix |
| --- | --- | --- |
| Single arrow press, focused row, neighbor item | Smooth (item is in view; no `scrollToIndex`) | Smooth (unchanged) |
| Single arrow press, focused row, scrollToIndex required | Freezes part-way once recycling kicks in | Smooth — drain runs after `isMomentumEnd` |
| Long-distance `scrollToIndex` (first → last) | Severe freeze (timer fires mid-animation) | Smooth — drain waits for actual scroll-end |
| Held arrow key (key-repeat ~30 ms) | Severe freeze, near-zero progress | Smooth (`isProgrammaticScrollActive` stays true across overlapping presses; one drain at the merged end) |
| Arrow keys with focus in search input | Smooth | Smooth (unchanged — input is not in the list) |
| Tab key navigation | Smooth | Smooth (unchanged — `isProgrammaticScrollActive` is false during Tab) |
| Screen reader reading order | Correct (patch-007 sort still applies after the scroll) | Correct (unchanged) |
| Cross-item text selection | Correct (sort still applies after the scroll) | Correct (unchanged) |

## 9. Verification

### Automated

- `npm test` — 183/183 unit tests pass.
- `npx tsc -b` — clean type-check.

### Manual repro (web)

1. Open a long `SelectionListWithSections` (≥ 500 rows). Click a row in the middle — blue focus outline visible.
2. **Arrow-key from the middle, single press** — must scroll smoothly to the next visually-off-screen row without freezing.
3. **Hold arrow-down** — must scroll smoothly to the end without stalling.
4. **First → last with a single keystroke** (long distance) — must scroll smoothly to the bottom without freezing partway.
5. **Tab through rows** — must land on the visually-next row each time.
6. **Click search input, then arrow-down** — must scroll smoothly without freezing (this path was never broken; regression check).
7. **Screen reader reading order** — items must read top to bottom.
8. **Cross-item text selection** — drag-select across multiple rows, paste; must produce a coherent range.

## 10. Files changed

| File | Change |
| --- | --- |
| `src/recyclerview/hooks/useRecyclerViewController.tsx` | Added `isProgrammaticScrollActive` and `pendingAfterScrollRef`; implemented `isScrollingProgrammatically`, `runAfterProgrammaticScroll`, and `notifyProgrammaticScrollSettled`; flipped `isProgrammaticScrollActive.current = true` at `scrollToIndex` entry. |
| `src/recyclerview/RecyclerView.tsx` | Destructured the three new methods from the controller; invoked `notifyProgrammaticScrollSettled` inside the existing `isMomentumEnd` branch (before the early return); forwarded `isScrollingProgrammatically` and `runAfterProgrammaticScroll` to `<ViewHolderCollection />` as props. |
| `src/recyclerview/ViewHolderCollection.tsx` | Added the two methods to `ViewHolderCollectionProps`; destructured them from props; added the `maybeDoSort` wrapper; routed the `focusin` listener and the immediate branch of the sort effect through it. |

`src/recyclerview/RecyclerViewContextProvider.ts` and `src/recyclerview/LayoutCommitObserver.tsx` are untouched — the public `FlashListContext` interface is unchanged from upstream, and the LCO context-forwarding logic is unchanged.

No new public API. No new files. No new dependencies. No new DOM event listeners. No new timers.

## 11. Alternatives considered (and rejected)

| Alternative | Why rejected |
| --- | --- |
| Consumer-side: pass `animated: false` to `scrollToIndex` | Eliminates the freeze but replaces smooth scroll with an abrupt jump. UX regression, not a library fix. |
| Remove patch 007 | Regresses screen-reader / Tab / cross-item selection. |
| Drain inside the existing 200/300 ms `setTimeout` | What earlier attempts tried. The timer is a heuristic, not a scroll-end signal — it fires mid-animation for long scrolls (see §4). |
| Install our own per-press `scrollend` listener | Works on Chromium / Firefox but duplicates `VelocityTracker` infrastructure FlashList already maintains, requires per-press setup/teardown, lacks a native fallback, and would need press-id arithmetic for overlap handling that `isMomentumEnd` already gives us for free. |
| Replace `element.scroll({behavior:'smooth'})` with a manual rAF animation | Large change; still cancellable by `restoreSelection`. |
| Detach focused row from the scroll container (portal) | Breaks Tab / hover / hit-testing. |
| Gate on `isRecentFocus` differently | Doesn't address the mechanism — the kill chain is triggered by the sort effect's commit, not by `focusin` itself. |
| Promote `pauseOffsetCorrection` to React state | Re-renders on every programmatic scroll. |
| Fix `pauseOffsetCorrection`'s lifecycle directly here | Conflates two independent concerns; would change downstream behaviors out of scope for this fix. |
| `MutationObserver`-based `scrollTop` rollback | Fights React's intended `restoreSelection` behavior; flaky. |

## 12. Glossary

| Term | Meaning |
| --- | --- |
| **Patch 007** | `@shopify+flash-list+2.3.0+007+sort-for-natural-DOM-order.patch`. Sorts `renderEntriesRef` so DOM order matches visual order on web. Adds the deferred (1 s) sort and the focusin-driven fast-track sort. |
| **`renderEntriesRef`** | Ref in `ViewHolderCollection` holding the stable render order across renders. Reconciliation appends new keys and removes departed ones; `doSort` reorders by `index`. |
| **`doSort`** | Sorts `renderEntriesRef` in place by data index, then calls `setSortId(prev => prev + 1)` to schedule a React commit whose only purpose is reordering DOM children via `insertBefore`. |
| **`maybeDoSort`** | New wrapper introduced by this fix. Defers `doSort` via `runAfterProgrammaticScroll` if `isScrollingProgrammatically()` is true; otherwise calls `doSort` immediately. |
| **`pauseOffsetCorrection`** | Pre-existing controller ref that gates `applyOffsetCorrection`. Cleared by the 200/300 ms `setTimeout` inside `finishScrollToIndex`. **Not touched by this fix.** |
| **`isProgrammaticScrollActive`** | New controller ref introduced by this fix. Tracks "is a programmatic scroll in flight?" with strict semantics: set at `scrollToIndex` entry, cleared exactly once when `isMomentumEnd` fires. |
| **`isMomentumEnd`** | Signal computed by `helpers/VelocityTracker.ts` `computeVelocity`. `true` exactly once when no `scroll` events have fired for 100 ms — i.e. when the merged smooth scroll has truly settled. |
| **`restoreSelection`** | React-DOM internal that re-focuses the saved active element and writes back saved `scrollTop`/`scrollLeft` of its scrollable ancestors. Runs in the commit phase after mutations are applied. |
| **CSSOM `scroll` cancellation** | Per [CSSOM-View §7.3](https://www.w3.org/TR/cssom-view-1/#dom-element-scrolltop), writing `element.scrollTop = N` performs an instant scroll, which aborts any in-flight `behavior: 'smooth'` animation on that element. |

## 13. Constants involved

| Constant | Value | Defined in | Purpose |
| --- | --- | --- | --- |
| `SORT_DELAY_MS` | 1000 | `ViewHolderCollection.tsx` | Deferred-sort debounce after scrolling pauses. |
| `TAB_SCROLL_THRESHOLD_MS` | 400 | `ViewHolderCollection.tsx` | "Recent focus" window — within this many ms of the last `focusin`, the sort effect takes the immediate branch (fast-track). |
| `setTimeout(animated ? 300 : 200)` | 200 / 300 | `useRecyclerViewController.tsx` (`finishScrollToIndex`) | Pre-existing heuristic timer that flips `pauseOffsetCorrection` and `setOffsetProjectionEnabled` back. **Untouched by this fix.** |
| `VelocityTracker` debounce | 100 | `helpers/VelocityTracker.ts` | How long after the last `scroll` event before `isMomentumEnd: true` fires. |
