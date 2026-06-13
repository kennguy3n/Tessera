import { useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { useWorkspace } from "./workspaceContext";

/**
 * How a navigation target should open, resolved from the modifier keys
 * (and mouse button) on the triggering event:
 *
 *   - `current`   — replace the focused tab's view (the default click).
 *   - `new-tab`   — open in a new tab of the focused pane
 *                   (Ctrl/Cmd-click).
 *   - `new-split` — open in a brand-new split off the focused pane
 *                   (Ctrl/Cmd+Shift-click, or middle-click).
 *
 * Platform handling matches the rest of the app: `metaKey` (⌘ on macOS)
 * and `ctrlKey` (Ctrl elsewhere) are treated interchangeably.
 */
export type OpenMode = "current" | "new-tab" | "new-split";

export function openModeFromEvent(
  e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "button">,
): OpenMode {
  // Middle-click always means "new split" regardless of modifiers.
  if (e.button === 1) return "new-split";
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return "current";
  return e.shiftKey ? "new-split" : "new-tab";
}

export interface OpenTargetHandlers {
  onClick: (e: ReactMouseEvent) => void;
  onAuxClick: (e: ReactMouseEvent) => void;
}

/**
 * Returns a factory that builds click/aux-click handlers for a
 * navigation target so the sidebar, quick switcher, and command
 * palette all share one consistent "open in new tab / new split"
 * gesture set, wired through the workspace pane-tree API.
 *
 * For a plain click (`current`) the factory invokes the supplied
 * `onCurrent` callback (e.g. the caller's existing navigate-and-close
 * behaviour) and does NOT prevent the default — so a real `<a>`/
 * `<NavLink>` still navigates the shell router as before. For new-tab
 * and new-split it prevents the default and routes through the
 * workspace API instead.
 */
export function useOpenTarget(): (
  path: string,
  opts?: { onCurrent?: () => void },
) => OpenTargetHandlers {
  const { openTab, openInSplit } = useWorkspace();
  return useCallback(
    (path: string, opts?: { onCurrent?: () => void }): OpenTargetHandlers => {
      const onClick = (e: ReactMouseEvent) => {
        const mode = openModeFromEvent(e);
        if (mode === "current") {
          opts?.onCurrent?.();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (mode === "new-split") openInSplit(path);
        else openTab(path);
      };
      const onAuxClick = (e: ReactMouseEvent) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        openInSplit(path);
      };
      return { onClick, onAuxClick };
    },
    [openTab, openInSplit],
  );
}
