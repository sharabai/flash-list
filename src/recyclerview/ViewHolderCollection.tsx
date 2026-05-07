/**
 * ViewHolderCollection is a container component that manages multiple ViewHolder instances.
 * It handles the rendering of a collection of list items, manages layout updates,
 * and coordinates with the RecyclerView context for layout changes.
 */

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import { Platform } from "react-native";

import { FlashListProps } from "../FlashListProps";

import { ViewHolder, ViewHolderProps } from "./ViewHolder";
import { RVDimension, RVLayout } from "./layout-managers/LayoutManager";
import { CompatView } from "./components/CompatView";
import { useRecyclerViewContext } from "./RecyclerViewContextProvider";

/**
 * Props interface for the ViewHolderCollection component
 * @template TItem - The type of items in the data array
 */
export interface ViewHolderCollectionProps<TItem> {
  /** The data array to be rendered */
  data: FlashListProps<TItem>["data"];
  /** Map of indices to React keys for each rendered item */
  renderStack: Map<string, { index: number }>;
  /** Function to get layout information for a specific index */
  getLayout: (index: number) => RVLayout;
  /** Ref to control layout updates from parent components */
  viewHolderCollectionRef: React.Ref<ViewHolderCollectionRef>;
  /** Map to store refs for each ViewHolder instance */
  refHolder: ViewHolderProps<TItem>["refHolder"];
  /** Callback when any item's size changes */
  onSizeChanged: ViewHolderProps<TItem>["onSizeChanged"];
  /** Function to render each item */
  renderItem: FlashListProps<TItem>["renderItem"];
  /** Additional data passed to renderItem that can trigger re-renders */
  extraData: any;
  /** Function to get the container's layout dimensions */
  getChildContainerLayout: () => RVDimension | undefined;
  /** Callback after layout effects are committed */
  onCommitLayoutEffect: () => void;
  /** Callback after effects are committed */
  onCommitEffect: () => void;
  /** Optional custom component to wrap each item */
  CellRendererComponent?: FlashListProps<TItem>["CellRendererComponent"];
  /** Optional component to render between items */
  ItemSeparatorComponent?: FlashListProps<TItem>["ItemSeparatorComponent"];
  /** Whether the list is horizontal or vertical */
  horizontal: FlashListProps<TItem>["horizontal"];
  /** Function to get the adjustment margin for the container.
   * For startRenderingFromBottom, we need to adjust the height of the container
   */
  getAdjustmentMargin: () => number;
  /** Current sticky index */
  currentStickyIndex: number;
  /** Whether the cell associated with an active sticky header is hidden */
  hideStickyHeaderRelatedCell: boolean;
  /** Returns whether the item at the given index is in the last row of the layout */
  isInLastRow: (index: number) => boolean;
  /** Whether the list is inverted */
  inverted: FlashListProps<TItem>["inverted"];
  /** True while a programmatic scroll is queued or in flight. */
  isScrollingProgrammatically: () => boolean;
  /** True while any scroll is in flight. */
  isScrolling: () => boolean;
  /** Register a callback to run when the current programmatic-scroll animation settles. */
  runAfterProgrammaticScroll: (cb: () => void) => void;
  /** Returns the timestamp (`Date.now()`) of the most recent scroll event, or 0 if none. */
  getLastScrollTime: () => number;
}

/**
 * Ref interface for ViewHolderCollection that exposes methods to control layout updates
 */
export interface ViewHolderCollectionRef {
  /** Forces a layout update by triggering a re-render */
  commitLayout: () => void;
}

const SORT_DELAY_MS = 1000;
// Max gap from last `focusin` to last `scroll` event for the scroll to
// count as a focus-induced auto-scroll-into-view (vs a user-driven scroll).
const FOCUS_INDUCED_SCROLL_WINDOW_MS = 30;

/**
 * Single-slot setTimeout with a fire-time gate. Calling `schedule` again
 * replaces any pending fire. When the timer expires, if `shouldDefer()`
 * returns true the timer reschedules itself instead of invoking
 * `callback`. Auto-cancels on unmount.
 *
 * @returns A tuple of `[schedule, cancel]`. `schedule` arms (or re-arms)
 * the timer; `cancel` evicts whatever is in the slot.
 */
function useDeferredCallback(
  callback: () => void,
  delayMs: number,
  shouldDefer: () => boolean,
): readonly [schedule: () => void, cancel: () => void] {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const schedule = useCallback(() => {
    cancel();
    timeoutRef.current = setTimeout(() => {
      if (shouldDefer()) {
        schedule();
        return;
      }
      timeoutRef.current = null;
      callback();
    }, delayMs);
  }, [callback, delayMs, shouldDefer, cancel]);

  useEffect(() => cancel, [cancel]);

  return [schedule, cancel];
}

/**
 * Walks up from `target` to find a `data-flashlist-index` marker among
 * a parent's direct children, returning the marker's `index` and the
 * walk-up `depth` (number of `parentElement` hops). Iterates siblings
 * last-to-first — the marker sits between `{children}` and `{separator}`
 * inside the ViewHolder, so it's near the end. Returns `null` if no
 * marker is found before reaching `root`.
 */
function findFocusedIndexFromMarker(
  target: Element | null,
  root: Element | null,
): { index: number; depth: number } | null {
  let current: Element | null = target;
  let depth = 0;
  while (current && current !== root) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const child = parent.children[i] as HTMLElement;
      const idxStr = child.dataset?.flashlistIndex;
      if (idxStr != null) {
        return { index: Number(idxStr), depth };
      }
    }
    current = parent;
    depth++;
  }
  return null;
}

/**
 * ViewHolderCollection component that manages the rendering of multiple ViewHolder instances
 * and handles layout updates for the entire collection
 * @template TItem - The type of items in the data array
 */
export const ViewHolderCollection = <TItem,>(
  props: ViewHolderCollectionProps<TItem>,
) => {
  const {
    data,
    renderStack,
    getLayout,
    refHolder,
    onSizeChanged,
    renderItem,
    extraData,
    viewHolderCollectionRef,
    getChildContainerLayout,
    onCommitLayoutEffect,
    CellRendererComponent,
    ItemSeparatorComponent,
    onCommitEffect,
    horizontal,
    getAdjustmentMargin,
    currentStickyIndex,
    hideStickyHeaderRelatedCell,
    isInLastRow,
    inverted,
    isScrollingProgrammatically,
    isScrolling,
    runAfterProgrammaticScroll,
    getLastScrollTime,
  } = props;

  const [renderId, setRenderId] = React.useState(0);

  const containerLayout = getChildContainerLayout();

  const fixedContainerSize = horizontal
    ? containerLayout?.height
    : containerLayout?.width;

  const recyclerViewContext = useRecyclerViewContext();

  useLayoutEffect(() => {
    if (renderId > 0) {
      // console.log(
      //   "parent layout trigger due to child container size change",
      //   fixedContainerSize
      // );
      recyclerViewContext?.layout();
    }
    // we need to run this callback on when fixedContainerSize changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedContainerSize]);

  useLayoutEffect(() => {
    if (renderId > 0) {
      onCommitLayoutEffect?.();
    }
    // we need to run this callback on when renderId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderId]);

  useEffect(() => {
    if (renderId > 0) {
      onCommitEffect?.();
    }
    // we need to run this callback on when renderId changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderId]);

  // Expose forceUpdate through ref
  useImperativeHandle(
    viewHolderCollectionRef,
    () => ({
      commitLayout: () => {
        // This will trigger a re-render of the component
        setRenderId((prev) => prev + 1);
      },
    }),
    [setRenderId],
  );

  const hasData = data && data.length > 0;

  const containerStyle = {
    width: horizontal ? containerLayout?.width : undefined,
    height: containerLayout?.height,
    marginTop: horizontal ? undefined : getAdjustmentMargin(),
    marginLeft: horizontal ? getAdjustmentMargin() : undefined,
    // TODO: Temp workaround, useLayoutEffect doesn't block paint in some cases
    // We need to investigate why this is happening
    opacity: renderId > 0 ? 1 : 0,
  };

  // sort by index and log
  // const sortedRenderStack = Array.from(renderStack.entries()).sort(
  //   ([, a], [, b]) => a.index - b.index
  // );
  // console.log(
  //   "sortedRenderStack",
  //   sortedRenderStack.map(([reactKey, { index }]) => {
  //     return `${index} => ${reactKey}`;
  //   })
  // );

  const containerRef = useRef<CompatView>(null);
  const lastFocusTimeRef = useRef(0);
  const lastFocusedIndexRef = useRef<number | null>(null);
  const lastFocusedDepthRef = useRef<number | null>(null);
  const shouldSortOnNextFocusRef = useRef(false);
  const renderEntriesRef = useRef(Array.from(renderStack.entries()));
  const [, bumpSortVersion] = useReducer((x: number) => x + 1, 0);

  const doSort = useCallback(() => {
    const entries = renderEntriesRef.current;
    const direction = inverted ? -1 : 1;
    const isSorted = entries.every(
      (entry, i) =>
        i === 0 || direction * (entries[i - 1][1].index - entry[1].index) <= 0,
    );
    if (isSorted) {
      return;
    }
    entries.sort(([, a], [, b]) => direction * (a.index - b.index));
    bumpSortVersion();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inverted]);

  const [schedulePendingSort, clearPendingSort] = useDeferredCallback(
    doSort,
    SORT_DELAY_MS,
    isScrolling,
  );

  const maybeDoSortOnFocus = useCallback(() => {
    clearPendingSort();
    if (isScrollingProgrammatically()) {
      runAfterProgrammaticScroll(schedulePendingSort);
      return;
    }
    if (shouldSortOnNextFocusRef.current) {
      shouldSortOnNextFocusRef.current = false;
      doSort();
    }
    schedulePendingSort();
  }, [
    isScrollingProgrammatically,
    isScrolling,
    runAfterProgrammaticScroll,
    schedulePendingSort,
    clearPendingSort,
    doSort,
    getLastScrollTime,
  ]);
  const maybeDoSortOnScroll = useCallback(() => {
    shouldSortOnNextFocusRef.current = true;
    // Evict any stale timer from a previous scroll's drain so it can't
    // fire mid-scroll during rapid-fire arrow nav (where `isMomentumEnd`
    // doesn't fire between key presses).
    clearPendingSort();
    if (isScrollingProgrammatically()) {
      runAfterProgrammaticScroll(schedulePendingSort);
      return;
    }
    if (isScrolling()) {
      // Focus-induced auto-scroll-into-view: sort sync to keep DOM
      // aligned for the next Tab. User-driven scrolls (negative Δ or Δ
      // past the window) defer to avoid sorting mid-mousewheel.
      const scrollSinceFocus = getLastScrollTime() - lastFocusTimeRef.current;
      const scrollNow =
        scrollSinceFocus >= 0 &&
        scrollSinceFocus < FOCUS_INDUCED_SCROLL_WINDOW_MS;
      if (scrollNow) {
        doSort();
        shouldSortOnNextFocusRef.current = false;
        return;
      }
    }
    schedulePendingSort();
  }, [
    isScrollingProgrammatically,
    isScrolling,
    runAfterProgrammaticScroll,
    schedulePendingSort,
    clearPendingSort,
    doSort,
    getLastScrollTime,
  ]);

  if (Platform.OS === "web") {
    // Reconcile: remove stale keys, append new keys
    const existingKeys = new Set(renderEntriesRef.current.map(([key]) => key));
    renderEntriesRef.current = renderEntriesRef.current.filter(([key]) =>
      renderStack.has(key),
    );
    for (const key of renderStack.keys()) {
      if (!existingKeys.has(key)) {
        renderEntriesRef.current.push([key, renderStack.get(key)!]);
      }
    }
  } else {
    renderEntriesRef.current = Array.from(renderStack.entries());
  }

  useEffect(() => {
    const container = containerRef.current as HTMLElement | null;
    if (Platform.OS !== "web" || !container) {
      return;
    }
    const onFocusIn = (e: FocusEvent) => {
      // Filter spurious focusins (recycle re-focus, mutation-phase
      // phantoms).
      const focused = findFocusedIndexFromMarker(
        e.target as Element | null,
        containerRef.current as unknown as Element | null,
      );
      const focusedIndex = focused?.index ?? null;
      const focusedDepth = focused?.depth ?? null;
      const isSameLogicalRow =
        focusedIndex !== null &&
        focusedIndex === lastFocusedIndexRef.current &&
        focusedDepth === lastFocusedDepthRef.current;
      const isPhantomMutationFocus =
        e.relatedTarget === null && focusedIndex !== null;
      if (isSameLogicalRow || isPhantomMutationFocus) {
        return;
      }
      lastFocusedIndexRef.current = focusedIndex;
      lastFocusedDepthRef.current = focusedDepth;
      lastFocusTimeRef.current = Date.now();
      maybeDoSortOnFocus();
    };
    container.addEventListener("focusin", onFocusIn);
    return () => container.removeEventListener("focusin", onFocusIn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") {
      return;
    }

    maybeDoSortOnScroll();
    return clearPendingSort;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderStack, renderId]);

  return (
    <CompatView ref={containerRef} style={hasData && containerStyle}>
      {containerLayout &&
        hasData &&
        renderEntriesRef.current.map(([reactKey, { index }]) => {
          const item = data[index];
          // Suppress separators for items in the last row to prevent
          // height mismatch. The last data item has no separator (no
          // trailingItem), so all items sharing its row must match.
          const trailingItem =
            ItemSeparatorComponent && !isInLastRow(index)
              ? data[index + 1]
              : undefined;

          return (
            <ViewHolder
              key={reactKey}
              index={index}
              item={item}
              trailingItem={trailingItem}
              layout={{
                ...getLayout(index),
              }}
              refHolder={refHolder}
              onSizeChanged={onSizeChanged}
              target="Cell"
              renderItem={renderItem}
              extraData={extraData}
              CellRendererComponent={CellRendererComponent}
              ItemSeparatorComponent={ItemSeparatorComponent}
              horizontal={horizontal}
              hidden={
                hideStickyHeaderRelatedCell && currentStickyIndex === index
              }
              inverted={inverted}
            />
          );
        })}
    </CompatView>
  );
};
