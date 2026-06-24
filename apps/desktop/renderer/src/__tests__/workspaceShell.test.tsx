/**
 * Integration tests for the workspace shell — the thin React layer over
 * the pure `paneTree` reducers (which have their own exhaustive unit
 * tests in `paneTree.test.ts`). These exercise the wiring the reducers
 * can't: the `tessera:*` command bus, tab/split rendering, tab
 * drag-and-drop between panes, the keyboard-resizable splitter, the
 * shell <-> focused-tab navigation bridge, and localStorage persistence
 * across a remount.
 *
 * `AppRoutes` is stubbed so a tab mounts a trivial child instead of the
 * real (IPC-heavy, lazily-loaded) page tree: we are testing the
 * workspace mechanics here, not the pages.
 */

import { act } from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceProvider from "../workspace/WorkspaceProvider";
import WorkspaceView from "../workspace/WorkspaceView";
import { useWorkspace } from "../workspace/workspaceContext";
import { countLeaves, getFocusedLeaf, listLeaves } from "../utils/paneTree";

vi.mock("../components/AppRoutes", () => ({
  default: () => <div data-testid="route-stub" />,
}));

const STORAGE_KEY = "tessera:workspace-layout";

/** A minimal DataTransfer good enough for jsdom drag events: a typed
 *  key/value store plus the `types` list the strip handlers check. */
function makeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return Array.from(store.keys());
    },
    dropEffect: "none",
    effectAllowed: "all",
  } as unknown as DataTransfer;
}

function Probe() {
  const ws = useWorkspace();
  const loc = useLocation();
  const navigate = useNavigate();
  const focused = getFocusedLeaf(ws.state);
  return (
    <div>
      <span data-testid="leaves">{countLeaves(ws.state.root)}</span>
      <span data-testid="focused-tabs">{focused.tabs.length}</span>
      <span data-testid="active-path">{ws.activePath}</span>
      <span data-testid="outer-path">{loc.pathname}</span>
      <span data-testid="maximized">{ws.state.maximizedPaneId ?? ""}</span>
      <span data-testid="focused-stacked">
        {focused.stacked === true ? "yes" : "no"}
      </span>
      <span data-testid="focused-follows">{focused.followPaneId ?? ""}</span>
      <button onClick={() => navigate("/memory")}>shell-nav</button>
      <button onClick={() => ws.navigateActive("/templates")}>tab-nav</button>
      <button onClick={() => ws.openTab("/templates")}>api-open-tab</button>
      <button onClick={() => ws.openInSplit("/memory")}>api-open-split</button>
      <button
        onClick={() => {
          // Link the focused (follower) pane to the other leaf (leader).
          const leaves = listLeaves(ws.state.root);
          const other = leaves.find((l) => l.id !== focused.id);
          if (other) ws.setPaneLink(focused.id, other.id);
        }}
      >
        link-to-other
      </button>
    </div>
  );
}

function renderWorkspace() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <WorkspaceProvider>
        <Probe />
        <WorkspaceView />
      </WorkspaceProvider>
    </MemoryRouter>,
  );
}

function fireBus(event: string) {
  act(() => {
    window.dispatchEvent(new Event(event));
  });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("workspace shell — default", () => {
  it("renders a single pane with one tab (unchanged first-run shell)", () => {
    renderWorkspace();
    expect(screen.getByTestId("leaves").textContent).toBe("1");
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    // The active tab's route view is mounted exactly once.
    expect(screen.getAllByTestId("route-stub")).toHaveLength(1);
  });
});

describe("workspace shell — tabs", () => {
  it("opens a tab via the command bus and via the strip button", () => {
    renderWorkspace();
    fireBus("tessera:new-tab");
    expect(screen.getByTestId("focused-tabs").textContent).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(screen.getByTestId("focused-tabs").textContent).toBe("3");
    // Only the active tab is mounted, never all three at once.
    expect(screen.getAllByTestId("route-stub")).toHaveLength(1);
  });

  it("activates a tab when its button is clicked", () => {
    renderWorkspace();
    fireBus("tessera:new-tab");
    const tabs = screen.getAllByRole("tab");
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tabs[0]);
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("closes a tab by clicking its close glyph", () => {
    renderWorkspace();
    fireBus("tessera:new-tab");
    expect(screen.getByTestId("focused-tabs").textContent).toBe("2");
    // The close affordance is a presentational glyph inside the tab (a
    // closable tab cannot own a nested interactive button under ARIA), so
    // close is driven by clicking the glyph — the tab's onClick detects it.
    const tab = screen.getAllByRole("tab")[0];
    const closeGlyph = tab.querySelector(".workspace-tab-close")!;
    fireEvent.click(closeGlyph);
    expect(screen.getByTestId("focused-tabs").textContent).toBe("1");
  });

  it("closes the focused tab with the Delete key", () => {
    renderWorkspace();
    fireBus("tessera:new-tab");
    expect(screen.getByTestId("focused-tabs").textContent).toBe("2");
    fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "Delete" });
    expect(screen.getByTestId("focused-tabs").textContent).toBe("1");
  });

  it("cycles tabs with next/prev bus commands", () => {
    renderWorkspace();
    fireBus("tessera:new-tab"); // now 2 tabs, second active
    fireBus("tessera:prev-tab");
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireBus("tessera:next-tab");
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("workspace shell — splits", () => {
  it("splits the pane via the command bus and collapses on last close", () => {
    renderWorkspace();
    fireBus("tessera:split-right");
    expect(screen.getByTestId("leaves").textContent).toBe("2");
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
    expect(screen.getByRole("separator")).toBeInTheDocument();

    // Closing the lone tab in the focused (new) pane collapses it.
    fireBus("tessera:close-tab");
    expect(screen.getByTestId("leaves").textContent).toBe("1");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("moves focus between panes via the command bus", () => {
    renderWorkspace();
    fireBus("tessera:split-right");
    const focusedAfterSplit = getFocusedPaneFromDom();
    fireBus("tessera:focus-prev-pane");
    expect(getFocusedPaneFromDom()).not.toBe(focusedAfterSplit);
    fireBus("tessera:focus-next-pane");
    expect(getFocusedPaneFromDom()).toBe(focusedAfterSplit);
  });

  it("resizes with the keyboard-accessible splitter", () => {
    renderWorkspace();
    fireBus("tessera:split-right");
    const sep = screen.getByRole("separator");
    const before = Number(sep.getAttribute("aria-valuenow"));
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    const after = Number(
      screen.getByRole("separator").getAttribute("aria-valuenow"),
    );
    expect(after).toBeLessThan(before);
  });
});

/** Index (0-based) of the focused pane among the rendered panes. */
function getFocusedPaneFromDom(): number {
  const panes = screen.getAllByLabelText("Workspace pane");
  return panes.findIndex((p) => p.getAttribute("data-focused") === "true");
}

describe("workspace shell — drag a tab between panes", () => {
  it("moves a dragged tab into another pane", () => {
    renderWorkspace();
    // Open a second tab in pane A, then split so pane B exists.
    fireBus("tessera:new-tab");
    fireBus("tessera:split-right");
    expect(screen.getByTestId("leaves").textContent).toBe("2");

    const lists = screen.getAllByRole("tablist");
    const paneATabs = within(lists[0]).getAllByRole("tab");
    const paneBList = lists[1];
    const beforeB = within(paneBList).getAllByRole("tab").length;

    const dt = makeDataTransfer();
    const draggable = paneATabs[0].closest(".workspace-tab")!;
    fireEvent.dragStart(draggable, { dataTransfer: dt });
    fireEvent.dragOver(paneBList, { dataTransfer: dt });
    fireEvent.drop(paneBList, { dataTransfer: dt });

    const afterB = within(screen.getAllByRole("tablist")[1]).getAllByRole(
      "tab",
    ).length;
    expect(afterB).toBe(beforeB + 1);
  });
});

describe("workspace shell — navigation bridge", () => {
  it("forwards a shell navigation into the focused tab and mirrors back", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByText("shell-nav"));
    await waitFor(() =>
      expect(screen.getByTestId("active-path").textContent).toBe("/memory"),
    );
    expect(screen.getByTestId("outer-path").textContent).toBe("/memory");
  });

  it("mirrors an in-tab navigation onto the shell URL", async () => {
    renderWorkspace();
    fireEvent.click(screen.getByText("tab-nav"));
    await waitFor(() =>
      expect(screen.getByTestId("active-path").textContent).toBe("/templates"),
    );
    expect(screen.getByTestId("outer-path").textContent).toBe("/templates");
  });
});

describe("workspace shell — persistence", () => {
  it("restores the layout from localStorage across a remount", async () => {
    const first = renderWorkspace();
    fireBus("tessera:split-right");
    fireBus("tessera:new-tab");
    expect(screen.getByTestId("leaves").textContent).toBe("2");

    // Wait for the debounced write to land.
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy());
    first.unmount();
    cleanup();

    renderWorkspace();
    expect(screen.getByTestId("leaves").textContent).toBe("2");
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  it("falls back to a single pane on corrupt persisted data", () => {
    localStorage.setItem(STORAGE_KEY, "{ not valid json");
    renderWorkspace();
    expect(screen.getByTestId("leaves").textContent).toBe("1");
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });
});

describe("workspace shell — open-in affordances (Feature 2)", () => {
  it("opens a new tab in the focused pane via the workspace API", () => {
    renderWorkspace();
    expect(screen.getByTestId("focused-tabs").textContent).toBe("1");
    fireEvent.click(screen.getByText("api-open-tab"));
    expect(screen.getByTestId("focused-tabs").textContent).toBe("2");
    // Still a single pane — a new *tab*, not a split.
    expect(screen.getByTestId("leaves").textContent).toBe("1");
  });

  it("opens a destination in a new split via the workspace API", () => {
    renderWorkspace();
    expect(screen.getByTestId("leaves").textContent).toBe("1");
    fireEvent.click(screen.getByText("api-open-split"));
    expect(screen.getByTestId("leaves").textContent).toBe("2");
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });
});

describe("workspace shell — ergonomics (Feature 4)", () => {
  it("maximizes and restores the focused pane via the bus", () => {
    renderWorkspace();
    fireBus("tessera:split-right");
    expect(screen.getAllByRole("tablist")).toHaveLength(2);

    // Maximize: only the focused pane is mounted.
    fireBus("tessera:maximize-pane");
    expect(screen.getByTestId("maximized").textContent).not.toBe("");
    expect(screen.getAllByRole("tablist")).toHaveLength(1);

    // Restore: both panes are mounted again.
    fireBus("tessera:maximize-pane");
    expect(screen.getByTestId("maximized").textContent).toBe("");
    expect(screen.getAllByRole("tablist")).toHaveLength(2);
  });

  it("closes other tabs in the focused pane via the bus", () => {
    renderWorkspace();
    fireBus("tessera:new-tab");
    fireBus("tessera:new-tab");
    expect(screen.getByTestId("focused-tabs").textContent).toBe("3");
    fireBus("tessera:close-others");
    expect(screen.getByTestId("focused-tabs").textContent).toBe("1");
  });

  it("closes tabs to the right of the active tab via the bus", () => {
    renderWorkspace();
    fireBus("tessera:new-tab"); // tab 2 (active)
    fireBus("tessera:new-tab"); // tab 3 (active)
    fireBus("tessera:prev-tab"); // back to tab 2 active
    expect(screen.getByTestId("focused-tabs").textContent).toBe("3");
    fireBus("tessera:close-to-right");
    // Tab 3 (to the right of active) is closed; tabs 1 and 2 remain.
    expect(screen.getByTestId("focused-tabs").textContent).toBe("2");
  });

  it("toggles stacked tabs on the focused pane via the bus", () => {
    renderWorkspace();
    expect(screen.getByTestId("focused-stacked").textContent).toBe("no");
    fireBus("tessera:toggle-stacked");
    expect(screen.getByTestId("focused-stacked").textContent).toBe("yes");
    expect(
      document.querySelector(".workspace-tabstrip.is-stacked"),
    ).toBeTruthy();
    fireBus("tessera:toggle-stacked");
    expect(screen.getByTestId("focused-stacked").textContent).toBe("no");
  });

  it("creates a split when a tab is dropped on a pane edge (drag-to-split)", () => {
    const { container } = renderWorkspace();
    // Two tabs in the single pane so one can be carried into a split.
    fireBus("tessera:new-tab");
    expect(screen.getByTestId("leaves").textContent).toBe("1");

    const tab = container.querySelector(".workspace-tab")!;
    const content = container.querySelector(".workspace-pane-content")!;
    const dt = makeDataTransfer();
    fireEvent.dragStart(tab, { dataTransfer: dt });
    fireEvent.dragOver(content, { dataTransfer: dt, clientX: 5, clientY: 200 });
    // The edge overlay appears while hovering.
    expect(container.querySelector(".workspace-pane-dropzone")).toBeTruthy();
    fireEvent.drop(content, { dataTransfer: dt, clientX: 5, clientY: 200 });
    expect(screen.getByTestId("leaves").textContent).toBe("2");
  });
});

describe("workspace shell — linked panes (Feature 3)", () => {
  it("makes a follower pane track the leader's active route", async () => {
    renderWorkspace();
    fireBus("tessera:split-right"); // pane B focused
    fireBus("tessera:focus-prev-pane"); // focus pane A (the leader)
    fireEvent.click(screen.getByText("tab-nav")); // A → /templates
    await waitFor(() =>
      expect(screen.getByTestId("active-path").textContent).toBe("/templates"),
    );

    fireBus("tessera:focus-next-pane"); // focus pane B (the follower)
    expect(screen.getByTestId("active-path").textContent).toBe("/");
    fireEvent.click(screen.getByText("link-to-other")); // B follows A

    await waitFor(() =>
      expect(screen.getByTestId("active-path").textContent).toBe("/templates"),
    );
    expect(screen.getByTestId("focused-follows").textContent).not.toBe("");
  });
});
