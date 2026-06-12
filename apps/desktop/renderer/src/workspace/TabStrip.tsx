import {
  useCallback,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import {
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import {
  getActiveTab,
  tabTitleForPath,
  type LeafPane,
} from "../utils/paneTree";
import { useWorkspace } from "./workspaceContext";

/** Custom drag MIME carrying the dragged tab's origin. Using a typed
 *  payload (not `text/plain`) keeps unrelated text drags from being
 *  mistaken for a tab move. */
const TAB_MIME = "application/x-tessera-tab";

interface TabDragData {
  paneId: string;
  tabId: string;
}

function readTabDrag(e: ReactDragEvent): TabDragData | null {
  try {
    const raw = e.dataTransfer.getData(TAB_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as TabDragData).paneId === "string" &&
      typeof (parsed as TabDragData).tabId === "string"
    ) {
      return parsed as TabDragData;
    }
  } catch {
    // Not our payload.
  }
  return null;
}

interface TabStripProps {
  leaf: LeafPane;
}

/**
 * The per-pane tab bar: an ARIA `tablist` of the pane's tabs plus pane
 * actions (new tab, split right, split down). Tabs are reorderable
 * within the strip and draggable to other panes (HTML5 DnD with a
 * typed payload); the drop index is derived from the pointer's
 * position relative to each tab's midpoint. All mutations go through
 * the pure `paneTree` reducers via the workspace API.
 */
export default function TabStrip({ leaf }: TabStripProps): ReactNode {
  const { activateTab, closeTab, openTab, splitFocused, moveTab, focusPane } =
    useWorkspace();
  const active = getActiveTab(leaf);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const onTabDragStart = useCallback(
    (e: ReactDragEvent, tabId: string) => {
      e.dataTransfer.setData(
        TAB_MIME,
        JSON.stringify({ paneId: leaf.id, tabId }),
      );
      e.dataTransfer.effectAllowed = "move";
    },
    [leaf.id],
  );

  const computeIndex = useCallback(
    (e: ReactDragEvent, tabIndex: number): number => {
      const rect = (
        e.currentTarget as HTMLElement
      ).getBoundingClientRect();
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

  const onStripDragOver = useCallback((e: ReactDragEvent) => {
    if (!e.dataTransfer.types.includes(TAB_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIndex((cur) => (cur === null ? leaf.tabs.length : cur));
  }, [leaf.tabs.length]);

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
      className="workspace-tabstrip"
      onDragOver={onStripDragOver}
      onDrop={onDrop}
      onDragLeave={onDragLeaveStrip}
      onMouseDown={() => focusPane(leaf.id)}
    >
      <div className="workspace-tabstrip-tabs" role="tablist" aria-label="Open tabs">
        {leaf.tabs.map((tab, i) => {
          const isActive = tab.id === active.id;
          const title = tabTitleForPath(tab.path);
          return (
            <div
              key={tab.id}
              className={`workspace-tab ${isActive ? "is-active" : ""} ${
                dropIndex === i ? "drop-before" : ""
              }`}
              draggable
              onDragStart={(e) => onTabDragStart(e, tab.id)}
              onDragOver={(e) => onTabDragOver(e, i)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                className="workspace-tab-button"
                title={tab.path}
                onClick={() => activateTab(leaf.id, tab.id)}
              >
                {title}
              </button>
              <button
                type="button"
                className="workspace-tab-close"
                aria-label={`Close ${title} tab`}
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(leaf.id, tab.id);
                }}
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
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
      </div>
    </div>
  );
}
