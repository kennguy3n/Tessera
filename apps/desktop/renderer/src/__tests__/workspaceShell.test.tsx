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
import { countLeaves, getFocusedLeaf } from "../utils/paneTree";

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
  return (
    <div>
      <span data-testid="leaves">{countLeaves(ws.state.root)}</span>
      <span data-testid="focused-tabs">
        {getFocusedLeaf(ws.state).tabs.length}
      </span>
      <span data-testid="active-path">{ws.activePath}</span>
      <span data-testid="outer-path">{loc.pathname}</span>
      <button onClick={() => navigate("/memory")}>shell-nav</button>
      <button onClick={() => ws.navigateActive("/templates")}>tab-nav</button>
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

  it("closes a tab via its close button", () => {
    renderWorkspace();
    fireBus("tessera:new-tab");
    expect(screen.getByTestId("focused-tabs").textContent).toBe("2");
    fireEvent.click(screen.getAllByRole("button", { name: /Close .* tab/ })[0]);
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
