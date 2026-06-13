import type { DragEvent as ReactDragEvent } from "react";

/**
 * Custom drag MIME carrying the dragged tab's origin. Using a typed
 * payload (not `text/plain`) keeps unrelated text drags from being
 * mistaken for a tab move, and lets both the tab strip (reorder / move)
 * and the pane body (drag-to-split) recognize the same gesture.
 */
export const TAB_MIME = "application/x-tessera-tab";

export interface TabDragData {
  readonly paneId: string;
  readonly tabId: string;
}

/** Serialize a tab-drag payload onto a drag event's dataTransfer. */
export function writeTabDrag(e: ReactDragEvent, data: TabDragData): void {
  e.dataTransfer.setData(TAB_MIME, JSON.stringify(data));
  e.dataTransfer.effectAllowed = "move";
}

/** Parse our typed tab-drag payload, or `null` when the event carries
 *  something else. Never throws. */
export function readTabDrag(e: ReactDragEvent): TabDragData | null {
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
      return { paneId: (parsed as TabDragData).paneId, tabId: (parsed as TabDragData).tabId };
    }
  } catch {
    // Not our payload.
  }
  return null;
}
