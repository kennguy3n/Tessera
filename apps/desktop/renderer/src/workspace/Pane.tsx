import { type ReactNode } from "react";
import { getActiveTab, type LeafPane } from "../utils/paneTree";
import { useWorkspace } from "./workspaceContext";
import TabStrip from "./TabStrip";
import TabView from "./TabView";

interface PaneProps {
  leaf: LeafPane;
}

/**
 * A single leaf pane: its tab strip plus the content of its active
 * tab. Only the active tab is mounted (its router + page); switching
 * tabs unmounts the previous one, so a pane never runs more than one
 * page's hooks/IPC at a time. Clicking anywhere in the pane focuses it
 * so subsequent sidebar/palette/keyboard navigation targets this pane.
 */
export default function Pane({ leaf }: PaneProps): ReactNode {
  const { state, focusPane } = useWorkspace();
  const isFocused = state.focusedPaneId === leaf.id;
  const active = getActiveTab(leaf);

  return (
    <section
      className={`workspace-pane ${isFocused ? "is-focused" : ""}`}
      aria-label="Workspace pane"
      data-focused={isFocused ? "true" : undefined}
    >
      <TabStrip leaf={leaf} />
      <div
        className="workspace-pane-content"
        onMouseDownCapture={() => {
          if (!isFocused) focusPane(leaf.id);
        }}
      >
        <TabView
          key={active.id}
          paneId={leaf.id}
          tabId={active.id}
          initialPath={active.path}
        />
      </div>
    </section>
  );
}
