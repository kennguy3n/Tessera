import {
  useCallback,
  useMemo,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  Link2,
  Maximize2,
  MoreVertical,
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import {
  getActiveTab,
  listLeaves,
  tabTitleForPath,
  type LeafPane,
} from "../utils/paneTree";
import { useWorkspace } from "./workspaceContext";
import { TAB_MIME, readTabDrag, writeTabDrag } from "./tabDrag";
import ContextMenu, { type ContextMenuItem } from "../components/ContextMenu";
import { useContextMenu } from "../hooks/useContextMenu";

interface TabStripProps {
  leaf: LeafPane;
}

/**
 * The per-pane tab bar: an ARIA `tablist` of the pane's tabs plus pane
 * actions (new tab, split right, split down, pane options). Tabs are
 * reorderable within the strip and draggable to other panes (HTML5 DnD
 * with a typed payload); the drop index is derived from the pointer's
 * position relative to each tab's midpoint. Right-clicking a tab opens
 * a context menu (close others / close to the right / open in split);
 * the pane-options button toggles stacked tabs, maximize, even split,
 * and linked-pane following. All mutations go through the pure
 * `paneTree` reducers via the workspace API.
 */
export default function TabStrip({ leaf }: TabStripProps): ReactNode {
  const {
    state,
    activateTab,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    openTab,
    openInSplit,
    splitFocused,
    moveTab,
    focusPane,
    togglePaneStacked,
    toggleMaximize,
    equalizeSplits,
    setPaneLink,
  } = useWorkspace();
  const active = getActiveTab(leaf);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const tabMenu = useContextMenu();
  const paneMenu = useContextMenu();
  const [menuTabId, setMenuTabId] = useState<string | null>(null);

  const stacked = leaf.stacked === true;
  const isMaximized = state.maximizedPaneId === leaf.id;
  const otherLeaves = useMemo(
    () => listLeaves(state.root).filter((l) => l.id !== leaf.id),
    [state.root, leaf.id],
  );
  const leafCount = useMemo(() => listLeaves(state.root).length, [state.root]);

  const openTabMenu = useCallback(
    (e: ReactMouseEvent, tabId: string) => {
      focusPane(leaf.id);
      setMenuTabId(tabId);
      tabMenu.open(e);
    },
    [focusPane, leaf.id, tabMenu],
  );

  const tabMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (menuTabId === null) return [];
    const idx = leaf.tabs.findIndex((t) => t.id === menuTabId);
    if (idx === -1) return [];
    const tab = leaf.tabs[idx];
    return [
      {
        id: "close",
        label: "Close tab",
        onSelect: () => closeTab(leaf.id, tab.id),
      },
      {
        id: "close-others",
        label: "Close other tabs",
        disabled: leaf.tabs.length <= 1,
        onSelect: () => closeOtherTabs(leaf.id, tab.id),
      },
      {
        id: "close-right",
        label: "Close tabs to the right",
        disabled: idx === leaf.tabs.length - 1,
        onSelect: () => closeTabsToRight(leaf.id, tab.id),
      },
      {
        id: "split",
        label: "Open in new split",
        separatorAbove: true,
        onSelect: () => {
          focusPane(leaf.id);
          openInSplit(tab.path, "row");
        },
      },
    ];
  }, [
    menuTabId,
    leaf.id,
    leaf.tabs,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
    focusPane,
    openInSplit,
  ]);

  const paneMenuItems = useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      {
        id: "stacked",
        label: stacked ? "Unstack tabs" : "Stack tabs",
        onSelect: () => togglePaneStacked(leaf.id),
      },
      {
        id: "maximize",
        label: isMaximized ? "Restore pane" : "Maximize pane",
        onSelect: () => toggleMaximize(leaf.id),
      },
      {
        id: "even",
        label: "Even split sizes",
        disabled: leafCount < 2,
        onSelect: () => equalizeSplits(),
      },
    ];
    if (leaf.followPaneId !== undefined) {
      items.push({
        id: "unlink",
        label: "Unlink this pane",
        separatorAbove: true,
        onSelect: () => setPaneLink(leaf.id, null),
      });
    }
    otherLeaves.forEach((other, i) => {
      const label = tabTitleForPath(getActiveTab(other).path);
      const isLeader = leaf.followPaneId === other.id;
      items.push({
        id: `link-${other.id}`,
        label: isLeader ? `\u2713 Following: ${label}` : `Follow: ${label}`,
        separatorAbove: i === 0 && leaf.followPaneId === undefined,
        onSelect: () => setPaneLink(leaf.id, isLeader ? null : other.id),
      });
    });
    return items;
  }, [
    stacked,
    isMaximized,
    leafCount,
    leaf.id,
    leaf.followPaneId,
    otherLeaves,
    togglePaneStacked,
    toggleMaximize,
    equalizeSplits,
    setPaneLink,
  ]);

  const onTabDragStart = useCallback(
    (e: ReactDragEvent, tabId: string) => {
      writeTabDrag(e, { paneId: leaf.id, tabId });
    },
    [leaf.id],
  );

  const computeIndex = useCallback(
    (e: ReactDragEvent, tabIndex: number): number => {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const after = e.clientX > rect.left + rect.width / 2;
      return after ? tabIndex + 1 : tabIndex;
    },
    [],
  );

  const onTabDragOver = useCallback(
    (e: ReactDragEvent, tabIndex: number) => {
      // Only react to our typed payload.
      if (!e.dataTransfer.types.includes(TAB_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropIndex(computeIndex(e, tabIndex));
    },
    [computeIndex],
  );

  const onStripDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (!e.dataTransfer.types.includes(TAB_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropIndex((cur) => (cur === null ? leaf.tabs.length : cur));
    },
    [leaf.tabs.length],
  );

  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      const data = readTabDrag(e);
      const index = dropIndex ?? leaf.tabs.length;
      setDropIndex(null);
      if (!data) return;
      e.preventDefault();
      moveTab(
        { paneId: data.paneId, tabId: data.tabId },
        { paneId: leaf.id, index },
      );
    },
    [dropIndex, leaf.id, leaf.tabs.length, moveTab],
  );

  const onDragLeaveStrip = useCallback((e: ReactDragEvent) => {
    // Clear the indicator only when leaving the strip entirely, not when
    // crossing between child tabs.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDropIndex(null);
    }
  }, []);

  return (
    <div
      className={`workspace-tabstrip ${stacked ? "is-stacked" : ""}`}
      onDragOver={onStripDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeaveStrip}
      onMouseDown={() => focusPane(leaf.id)}
    >
      <div
        className="workspace-tabstrip-tabs"
        role="tablist"
        aria-label="Open tabs"
        aria-orientation="horizontal"
      >
        {leaf.tabs.map((tab, i) => {
          const isActive = tab.id === active.id;
          const title = tabTitleForPath(tab.path);
          const linked = leaf.followPaneId !== undefined;
          // The tab itself is the only role="tab" — a closable tab cannot
          // own a nested interactive close button (that violates ARIA's
          // `nested-interactive`) nor sit beside a sibling button inside the
          // tablist (that violates `aria-required-children`). So the close
          // affordance is a presentational glyph inside the tab, and closing
          // is wired through the tab's own handlers: clicking the glyph,
          // middle-click, the Delete shortcut, or the context menu.
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-keyshortcuts="Delete"
              className={`workspace-tab ${isActive ? "is-active" : ""} ${
                dropIndex === i ? "drop-before" : ""
              }`}
              title={`${tab.path} — press Delete to close`}
              draggable
              onDragStart={(e) => onTabDragStart(e, tab.id)}
              onDragOver={(e) => onTabDragOver(e, i)}
              onContextMenu={(e) => openTabMenu(e, tab.id)}
              onClick={(e) => {
                // Clicking the close glyph closes; anywhere else activates.
                if ((e.target as HTMLElement).closest(".workspace-tab-close")) {
                  e.preventDefault();
                  closeTab(leaf.id, tab.id);
                  return;
                }
                activateTab(leaf.id, tab.id);
              }}
              onAuxClick={(e) => {
                // Middle-click closes the tab (browser-style).
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(leaf.id, tab.id);
                }
              }}
              onKeyDown={(e) => {
                // Delete only — the WAI-ARIA tabs pattern's destructive key,
                // and exactly what `aria-keyshortcuts` advertises. Backspace
                // is deliberately not bound: it's historically browser-back
                // and would silently close a focused tab, surprising users
                // who reach for it as an edit key.
                if (e.key === "Delete") {
                  e.preventDefault();
                  closeTab(leaf.id, tab.id);
                }
              }}
            >
              {isActive && linked && (
                <Link2
                  size={12}
                  strokeWidth={2}
                  aria-hidden="true"
                  className="workspace-tab-link-icon"
                />
              )}
              <span className="workspace-tab-label">{title}</span>
              <span
                className="workspace-tab-close"
                aria-hidden="true"
                title="Close tab"
              >
                <X size={14} strokeWidth={2} />
              </span>
            </button>
          );
        })}
        {dropIndex === leaf.tabs.length && (
          <span className="workspace-tab-drop-end" aria-hidden="true" />
        )}
      </div>
      <div className="workspace-tabstrip-actions">
        <button
          type="button"
          className="workspace-tab-action"
          aria-label="New tab"
          title="New tab"
          onClick={() => {
            focusPane(leaf.id);
            openTab(undefined, leaf.id);
          }}
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="workspace-tab-action"
          aria-label="Split right"
          title="Split right"
          onClick={() => {
            focusPane(leaf.id);
            splitFocused("row");
          }}
        >
          <SplitSquareHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="workspace-tab-action"
          aria-label="Split down"
          title="Split down"
          onClick={() => {
            focusPane(leaf.id);
            splitFocused("column");
          }}
        >
          <SplitSquareVertical size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`workspace-tab-action ${isMaximized ? "is-active" : ""}`}
          aria-label={isMaximized ? "Restore pane" : "Maximize pane"}
          aria-pressed={isMaximized}
          title={isMaximized ? "Restore pane" : "Maximize pane"}
          onClick={() => toggleMaximize(leaf.id)}
        >
          <Maximize2 size={16} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="workspace-tab-action"
          aria-label="Pane options"
          aria-haspopup="menu"
          title="Pane options"
          onClick={(e) => {
            focusPane(leaf.id);
            paneMenu.open(e);
          }}
        >
          <MoreVertical size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <ContextMenu
        isOpen={tabMenu.isOpen}
        position={tabMenu.position}
        items={tabMenuItems}
        onClose={tabMenu.close}
      />
      <ContextMenu
        isOpen={paneMenu.isOpen}
        position={paneMenu.position}
        items={paneMenuItems}
        onClose={paneMenu.close}
      />
    </div>
  );
}
