import { Fragment, type ReactNode } from "react";
import {
  MIN_PANE_FRACTION,
  tabTitleForPath,
  getActiveTab,
  type SplitPane,
  type WorkspaceNode,
} from "../utils/paneTree";
import { useWorkspace } from "./workspaceContext";
import Pane from "./Pane";
import PaneSplitter from "./PaneSplitter";

function clampPair(value: number, pairSum: number): number {
  return Math.max(MIN_PANE_FRACTION, Math.min(pairSum - MIN_PANE_FRACTION, value));
}

/** A label like "Sources / Memory" naming the two panes a handle sits
 *  between, derived purely from their active-tab routes. */
function boundaryLabel(a: WorkspaceNode, b: WorkspaceNode): string {
  return `${nodeLabel(a)} and ${nodeLabel(b)}`;
}

function nodeLabel(node: WorkspaceNode): string {
  if (node.type === "leaf") return tabTitleForPath(getActiveTab(node).path);
  return "split";
}

function SplitContainer({ split }: { split: SplitPane }): ReactNode {
  const { resizeSplit } = useWorkspace();
  const { id, direction, children, sizes } = split;
  const step = 0.02;

  const applyBoundary = (i: number, leadingFraction: number) => {
    const next = [...sizes];
    const pairSum = next[i] + next[i + 1];
    const leading = clampPair(leadingFraction, pairSum);
    next[i] = leading;
    next[i + 1] = pairSum - leading;
    resizeSplit(id, next);
  };

  const onDragTo = (i: number, fraction: number) => {
    const before = sizes.slice(0, i).reduce((a, b) => a + b, 0);
    // `fraction` is measured from the container start; convert it to the
    // leading pane's share of the adjacent pair.
    applyBoundary(i, fraction - before);
  };

  const onStep = (i: number, delta: -1 | 1) => {
    applyBoundary(i, sizes[i] + delta * step);
  };

  return (
    <div className={`workspace-split workspace-split-${direction}`}>
      {children.map((child, i) => {
        const cumulative = sizes.slice(0, i + 1).reduce((a, b) => a + b, 0);
        return (
          <Fragment key={child.id}>
            <div
              className="workspace-split-cell"
              style={{ flexGrow: sizes[i], flexBasis: 0, flexShrink: 1 }}
            >
              {renderNode(child)}
            </div>
            {i < children.length - 1 && (
              <PaneSplitter
                direction={direction}
                valueNow={cumulative * 100}
                label={boundaryLabel(child, children[i + 1])}
                onDragTo={(f) => onDragTo(i, f)}
                onStep={(d) => onStep(i, d)}
              />
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function renderNode(node: WorkspaceNode): ReactNode {
  if (node.type === "leaf") return <Pane leaf={node} />;
  return <SplitContainer split={node} />;
}

/**
 * Renders the workspace pane tree. A thin presentational shell over the
 * pure layout in `utils/paneTree`: it walks the tree, sizing split
 * children by their stored fractions and inserting accessible
 * {@link PaneSplitter}s between siblings. The default (single-leaf)
 * layout renders exactly one {@link Pane}, so the first-run experience
 * is unchanged from the pre-workspace single-pane shell.
 */
export default function WorkspaceView(): ReactNode {
  const { state } = useWorkspace();
  return <div className="workspace-root">{renderNode(state.root)}</div>;
}
