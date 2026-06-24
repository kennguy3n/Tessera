import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import {
  getActiveTab,
  type LeafPane,
  type SplitDirection,
} from "../utils/paneTree";
import { useWorkspace } from "./workspaceContext";
import { TAB_MIME, readTabDrag } from "./tabDrag";
import TabStrip from "./TabStrip";
import TabView from "./TabView";

interface PaneProps {
  leaf: LeafPane;
}

/** Debounce window for reporting scroll offsets (ms) — coalesces a
 *  scroll gesture into a single state write so persistence stays cheap. */
const SCROLL_REPORT_MS = 200;

/** Which pane edge a tab is being dragged onto, mapped to the split it
 *  would create. `null` means no drop is in progress. */
type DropEdge = "left" | "right" | "top" | "bottom";

const EDGE_TO_SPLIT: Record<
  DropEdge,
  { direction: SplitDirection; before: boolean }
> = {
  left: { direction: "row", before: true },
  right: { direction: "row", before: false },
  top: { direction: "column", before: true },
  bottom: { direction: "column", before: false },
};

/**
 * A single leaf pane: its tab strip plus the content of its active
 * tab. Only the active tab is mounted (its router + page); switching
 * tabs unmounts the previous one, so a pane never runs more than one
 * page's hooks/IPC at a time. Clicking anywhere in the pane focuses it
 * so subsequent sidebar/palette/keyboard navigation targets this pane.
 *
 * The pane also:
 *   - restores and reports its active tab's scroll offset (UI-only
 *     state persisted across reloads), and
 *   - exposes four edge drop zones so a tab dragged from any strip can
 *     be dropped onto an edge to create a split (drag-to-split).
 */
export default function Pane({ leaf }: PaneProps): ReactNode {
  const { state, focusPane, reportTabScroll, splitWithTab } = useWorkspace();
  const isFocused = state.focusedPaneId === leaf.id;
  const active = getActiveTab(leaf);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [dropEdge, setDropEdge] = useState<DropEdge | null>(null);

  // Restore the persisted scroll offset whenever the active tab
  // changes (tab switch / reload). Best-effort: applied on the next
  // frame so the page content has laid out. Cheap and idempotent.
  const restoreTo = active.scrollTop ?? 0;
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = restoreTo;
    });
    return () => cancelAnimationFrame(raf);
  }, [active.id, restoreTo]);

  // Flush any pending scroll report on unmount so the last position
  // isn't lost.
  useEffect(
    () => () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  const onScroll = useCallback(() => {
    const el = contentRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      reportTabScroll(leaf.id, active.id, top);
    }, SCROLL_REPORT_MS);
  }, [active.id, leaf.id, reportTabScroll]);

  const edgeFromEvent = useCallback((e: ReactDragEvent): DropEdge => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    // Distance to each edge; the nearest wins, so a drop near a corner
    // resolves to whichever side the pointer is closest to.
    const dists: Array<[DropEdge, number]> = [
      ["left", x],
      ["right", 1 - x],
      ["top", y],
      ["bottom", 1 - y],
    ];
    dists.sort((a, b) => a[1] - b[1]);
    return dists[0][0];
  }, []);

  const onDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (!e.dataTransfer.types.includes(TAB_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropEdge(edgeFromEvent(e));
    },
    [edgeFromEvent],
  );

  const onDragLeave = useCallback((e: ReactDragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropEdge(null);
    }
  }, []);

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      const data = readTabDrag(e);
      const edge = dropEdge;
      setDropEdge(null);
      if (!data || !edge) return;
      e.preventDefault();
      const { direction, before } = EDGE_TO_SPLIT[edge];
      splitWithTab(data, leaf.id, direction, { before });
    },
    [dropEdge, leaf.id, splitWithTab],
  );

  return (
    <section
      className={`workspace-pane ${isFocused ? "is-focused" : ""}`}
      aria-label="Workspace pane"
      data-focused={isFocused ? "true" : undefined}
    >
      <TabStrip leaf={leaf} />
      <div
        ref={contentRef}
        className="workspace-pane-content"
        onScroll={onScroll}
        onMouseDownCapture={() => {
          if (!isFocused) focusPane(leaf.id);
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <TabView
          key={active.id}
          paneId={leaf.id}
          tabId={active.id}
          initialPath={active.path}
        />
      </div>
      {dropEdge && (
        <div
          className={`workspace-pane-dropzone is-${dropEdge}`}
          aria-hidden="true"
        />
      )}
    </section>
  );
}
