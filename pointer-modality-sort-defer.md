# Pointer-modality sort deferral

> **Status:** implemented. See §5 for the per-file changes with line citations to the live source.
>
> **Scope:** internal to `@shopify/flash-list`. No public API change. One new ref, one new `useEffect` with two document-level capture-phase listeners (`keydown`, `pointerdown`). Web-only — gated by `Platform.OS === "web"` everywhere it matters.

---

## 0. TL;DR

[`ViewHolderCollection`](src/recyclerview/ViewHolderCollection.tsx) tracks the modality of the user's most recent input in a ref (`lastInputModalityRef`): `"pointer"` (mouse / touch / pen) or `"keyboard"` (any keydown). When a `focusin` fires and `maybeDoSortOnFocus` would otherwise commit a sync sort (i.e. `shouldSortOnNextFocusRef` is armed), the sort is **deferred** if the modality is `"pointer"`. The pending sort still commits later via `schedulePendingSort` once the user makes a keyboard move (or after the standard `SORT_DELAY_MS` idle window if `isScrolling()` says nothing is in motion).

Without this gate, clicking a row's button would dispatch `mousedown` → `focusin` → sync sort (`bumpSortVersion()` re-renders the list with reordered children) → `mouseup` lands on a different DOM node → browser does not dispatch `click`. Buttons silently stopped firing on certain rows after enough scrolling caused the DOM order to drift from index order.

---

## 1. Why this exists — the lost-click race

### 1.1 Setup

Patch-007 (see [patch-details.md](patch-details.md)) keeps virtualized list items in CSS-positioned (`position: absolute`) order while scrolling and only commits a DOM reorder (sorting `renderEntriesRef` by data index and triggering `bumpSortVersion`) when it is safe to do so. Two existing gates already exist:

1. `isScrollingProgrammatically()` — defers the sort while a `scrollToIndex` is in flight, so React's commit-time `restoreSelection` cannot cancel the smooth scroll by writing `scrollTop`.
2. Scroll-momentum settling — `useDeferredCallback` re-checks `isScrolling()` and reschedules itself if any scroll is still in progress.

Neither of those gates fire on a static click. The user is not scrolling, the list is idle, and `shouldSortOnNextFocusRef` may already be armed from the last `maybeDoSortOnScroll` pass — which means the next `focusin` will commit the sort synchronously.

### 1.2 The browser's `click` invariant

Per the HTML spec and every mainstream browser implementation, a `click` event is dispatched **only if** `mousedown` and `mouseup` happen on the same DOM node (more precisely: on a node that contains both, walking up the tree). If the node that received `mousedown` is unmounted or replaced between `mousedown` and `mouseup` (or between `mouseup` and `click`), the click is dropped.

Synchronous DOM mutation triggered by React commit between `mousedown` and `mouseup` is one of the easiest ways to break this invariant. `insertBefore` calls produced by reordering children re-parent existing DOM nodes — even though the same React element (and therefore the same DOM node identity) is preserved across the reorder, the browser's hit-testing for the pending click can still get confused. In practice the `mouseup` lands on a different document position than the `mousedown` did, and the click is dropped.

### 1.3 The actual sequence (before the fix)

```
user clicks button on row N
  │
  ▼
mousedown on button → focusin on row N
  │                     │
  │                     ▼
  │              maybeDoSortOnFocus
  │                     │
  │                     ├─ isScrollingProgrammatically(): false
  │                     ├─ shouldSortOnNextFocusRef: true (armed by prior scroll)
  │                     │
  │                     ▼
  │              sortItems()  →  bumpSortVersion()
  │                     │
  │                     ▼
  │              React re-renders, emits insertBefore calls
  │                     │
  ▼                     ▼
mouseup → no `click` dispatched
```

The damage is the synchronous re-render inside the `mousedown` → `mouseup` window. Even if `mouseup` is microseconds away, React's commit runs before it.

---

## 2. The fix — modality-gated deferral

### 2.1 Tracking modality

Two document-level event listeners, registered in capture phase, set `lastInputModalityRef` on every interaction:

```ts
document.addEventListener("keydown", () => {
  lastInputModalityRef.current = "keyboard";
}, true);
document.addEventListener("pointerdown", () => {
  lastInputModalityRef.current = "pointer";
}, true);
```

- **Capture phase** so we observe the event before any application handler can `stopPropagation()` or `preventDefault()`.
- **Document-level** so we don't miss interactions outside the list. Modality is a global property of the user's last action.
- `pointerdown` (not `mousedown` / `touchstart` separately) covers mouse, touch, and pen uniformly.
- `keydown` (not `keypress`) covers Tab and assistive technologies. VoiceOver, NVDA, and JAWS all dispatch keydowns at the JS layer when the user does Ctrl+Opt+Arrow / VO+Arrow / virtual cursor navigation, so this also keeps screen-reader navigation working.

### 2.2 Initial value

`useRef<"pointer" | "keyboard">("pointer")`. The initial value is conservative: assume pointer until the user has demonstrated keyboard intent. This matches the spirit of `:focus-visible` (the browser also defaults to "not focus-visible" until keyboard navigation happens) but is more reliable across browsers and assistive tech because we observe the keydown directly rather than relying on the browser's heuristic.

The initial-value choice matters for the first interaction with the list: if the user's very first action after mount is a click, we want the modality to already be `"pointer"` by the time `focusin` fires, so the sort defers. The `pointerdown` listener does set it correctly in capture phase before `focusin`, but defaulting to `"pointer"` is a belt-and-suspenders safety net.

### 2.3 The new branch in `maybeDoSortOnFocus`

```ts
if (
  shouldSortOnNextFocusRef.current &&
  lastInputModalityRef.current === "pointer"
) {
  schedulePendingSort();
  return;
}
```

Placed **after** the `isScrollingProgrammatically()` gate and **before** the existing "consume the armed flag and sync-sort" branch.

Key properties:

- We do **not** consume `shouldSortOnNextFocusRef` in this branch. The flag stays armed so that the next non-pointer focus event (a real keyboard Tab) can still commit the sort synchronously. Otherwise pointer focus would silently disarm the flag and keyboard-driven sorts would stop happening until the next scroll-induced re-arm.
- We call `schedulePendingSort()` to ensure the sort still eventually commits even if the user never touches the keyboard again. The timer fires after `SORT_DELAY_MS` of idle (with the existing `isScrolling()` re-check on fire), well after any pending `click` has been dispatched and processed.
- We do **not** call `sortItems()`. The whole point is to delay the DOM reorder past the `mousedown` → `click` window.

---

## 3. Why this preserves keyboard correctness

The whole reason `maybeDoSortOnFocus` exists is to keep DOM order in sync with data-index order so the next Tab lands on the right row. The fix does not touch keyboard navigation:

- Tab fires `keydown` (in capture phase, before any focus change), which sets modality to `"keyboard"` **before** the resulting `focusin` runs.
- Arrow-key navigation (e.g. Expensify's `useArrowKeyFocusManager`) also fires `keydown`, same as above.
- VoiceOver's Ctrl+Opt+Arrow dispatches keydowns, same as above.

In all of these the new gate evaluates to false (`lastInputModalityRef.current === "keyboard"`), the existing sync-sort branch runs, and DOM order stays correct for the next keystroke.

---

## 4. Why other approaches don't work

| Approach                                       | Why it fails                                                                                                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Defer sort unconditionally on every focus      | Breaks keyboard Tab — the next Tab lands on the wrong row because DOM order is stale. The whole purpose of patch-007's sync-sort branch is keyboard correctness.                                                                                            |
| Use `:focus-visible` to decide                 | Not reliably observable from JS in a synchronous flow. Different browsers apply the heuristic differently, and the polyfilled version (`focus-visible` library) requires explicit calls. We need the signal _before_ focus moves, not after.                 |
| Listen for `mousedown` on the list container   | Misses keyboard-induced focus changes that should _not_ defer, and misses interactions that start outside the list (drag from outside to inside, focus restored by browser after dialog dismissal). A global, modality-tracking ref is the cleanest signal. |
| Schedule the sort with `setTimeout(..., 0)`    | The macrotask still runs before `mouseup` in many cases (the browser does not strictly serialize input events with task queue), and even if it didn't, React re-renders are far more expensive than what `setTimeout(0)` is designed for.                   |
| Block sort while `document.activeElement` is a focusable element on the list | Doesn't catch the race: the focused element at sort time _is_ the one we're about to break. We need to know whether the focus change came from a pointer interaction, not whether something is currently focused.                                           |

---

## 5. Per-file changes

### `src/recyclerview/ViewHolderCollection.tsx`

1. New ref alongside `renderEntriesRef`:

   ```ts
   const lastInputModalityRef = useRef<"pointer" | "keyboard">("pointer");
   ```

2. New branch in `maybeDoSortOnFocus`, between the `isScrollingProgrammatically()` gate and the existing armed-flag consumer:

   ```ts
   if (
     shouldSortOnNextFocusRef.current &&
     lastInputModalityRef.current === "pointer"
   ) {
     schedulePendingSort();
     return;
   }
   ```

3. New `useEffect` after the existing scroll-triggered effect, registering the two document-level capture-phase listeners.

The minimal comments in the source file delegate to this document for the full reasoning. All existing comments in `ViewHolderCollection.tsx` are preserved.

---

## 6. Interaction with other patches

- **Patch-007 sort-for-natural-DOM-order**: this fix lives inside `maybeDoSortOnFocus` and is composed with patch-007's existing gates. The `isScrollingProgrammatically()` defer runs first; only if that gate lets the flow through do we then check modality. Both gates schedule the deferred sort instead of committing it.
- **`isScrolling()` flag**: unchanged. The new gate is orthogonal — modality answers "what kind of interaction caused this focus?", `isScrolling()` answers "is the viewport in motion?".
- **`viewholder-marker-and-focus-filter.md`**: unchanged. The phantom-mutation / same-row filters still run first inside the `focusin` handler. Only real, distinct focus changes reach `maybeDoSortOnFocus`, and only then does the modality check apply.

---

## 7. References

- E/App issue (lost clicks after scrolling a virtualized list): tracked alongside the patch-details entry.
- HTML spec on `click` event dispatch: <https://html.spec.whatwg.org/multipage/interaction.html#run-authentic-click-activation-steps>
- `:focus-visible` heuristic: <https://drafts.csswg.org/selectors/#the-focus-visible-pseudo>
