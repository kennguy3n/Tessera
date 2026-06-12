/**
 * QuickSwitcher component tests — the ARIA combobox contract and
 * keyboard-only operation:
 *
 *   - input is a combobox driving a listbox via aria-activedescendant
 *   - Arrow / Home / End move the active row without leaving the input
 *   - Enter navigates to the active row's destination
 *   - Escape + overlay click close
 *   - graceful no-bridge / empty / error states
 *   - fuzzy-matched characters are highlighted in the title
 *
 * Data + recents hooks are mocked so the test drives a deterministic
 * item set and stays independent of IPC; ranking itself is covered by
 * `utils/__tests__/quickSwitch.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { QuickSwitchItem } from "../utils/quickSwitch";

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigateMock };
});

interface ItemsState {
  items: QuickSwitchItem[];
  loading: boolean;
  error: string | null;
  hasBridge: boolean;
  refreshAll: () => void;
}

const itemsState: ItemsState = {
  items: [],
  loading: false,
  error: null,
  hasBridge: true,
  refreshAll: vi.fn(),
};
let recentIds: string[] = [];

vi.mock("../hooks/useQuickSwitcherItems", () => ({
  useQuickSwitcherItems: () => itemsState,
}));
vi.mock("../hooks/useRecentlyViewedArtifacts", () => ({
  useRecentlyViewedArtifacts: () => ({ recentIds }),
}));

import QuickSwitcher from "../components/QuickSwitcher";

function item(
  id: string,
  title: string,
  to: string,
  extra: Partial<QuickSwitchItem> = {},
): QuickSwitchItem {
  return {
    id,
    kind: "artifact",
    title,
    subtitle: "Artifact · document",
    keywords: "",
    to,
    recentKey: id,
    ...extra,
  };
}

function setItems(items: QuickSwitchItem[], overrides: Partial<ItemsState> = {}) {
  itemsState.items = items;
  itemsState.loading = overrides.loading ?? false;
  itemsState.error = overrides.error ?? null;
  itemsState.hasBridge = overrides.hasBridge ?? true;
}

function renderSwitcher(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <QuickSwitcher isOpen onClose={onClose} />
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => {
  navigateMock.mockReset();
  recentIds = [];
  setItems([]);
});

describe("QuickSwitcher", () => {
  it("renders a combobox + listbox and marks the first row active", () => {
    setItems([
      item("a", "Alpha", "/a"),
      item("b", "Bravo", "/b"),
    ]);
    renderSwitcher();
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-controls");
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    // The active descendant id resolves to a real option in the listbox.
    expect(document.getElementById(active!)).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("moves the active row with ArrowDown/Up and clamps at the ends", () => {
    setItems([item("a", "Alpha", "/a"), item("b", "Bravo", "/b")]);
    renderSwitcher();
    const input = screen.getByRole("combobox");
    const idOf = () => input.getAttribute("aria-activedescendant");
    const first = idOf();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const second = idOf();
    expect(second).not.toBe(first);
    // Clamps at the bottom.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(idOf()).toBe(second);
    // Back up and clamp at the top.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(idOf()).toBe(first);
  });

  it("Home and End jump to the extremes", () => {
    setItems([
      item("a", "Alpha", "/a"),
      item("b", "Bravo", "/b"),
      item("c", "Charlie", "/c"),
    ]);
    renderSwitcher();
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "End" });
    const endId = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(endId!)?.textContent).toContain("Charlie");
    fireEvent.keyDown(input, { key: "Home" });
    const homeId = input.getAttribute("aria-activedescendant");
    expect(document.getElementById(homeId!)?.textContent).toContain("Alpha");
  });

  it("Enter navigates to the active row and closes", () => {
    setItems([item("a", "Alpha", "/a"), item("b", "Bravo", "/b")]);
    const onClose = renderSwitcher();
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(navigateMock).toHaveBeenCalledWith("/b");
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking a row navigates to it", () => {
    setItems([item("a", "Alpha", "/a")]);
    renderSwitcher();
    fireEvent.click(screen.getByText("Alpha"));
    expect(navigateMock).toHaveBeenCalledWith("/a");
  });

  it("Escape closes the switcher", () => {
    setItems([item("a", "Alpha", "/a")]);
    const onClose = renderSwitcher();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking the overlay closes the switcher", () => {
    setItems([item("a", "Alpha", "/a")]);
    const onClose = renderSwitcher();
    fireEvent.click(screen.getByTestId("quick-switcher-overlay"));
    expect(onClose).toHaveBeenCalled();
  });

  it("filters as the user types and highlights matched characters", () => {
    setItems([item("a", "Roadmap", "/a"), item("b", "Budget", "/b")]);
    renderSwitcher();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "rdm" } });
    expect(screen.queryByText("Budget")).not.toBeInTheDocument();
    const listbox = screen.getByRole("listbox");
    // Matched chars render inside <mark> elements.
    expect(within(listbox).getAllByText(/[a-z]/i, { selector: "mark" }).length)
      .toBeGreaterThan(0);
  });

  it("surfaces the no-bridge notice even when navigable rows exist", () => {
    // Pages (from SIDEBAR_ITEMS) are always present, so the switcher is
    // never empty when the bridge is absent — the notice must show
    // alongside the page rows rather than only on an empty list.
    setItems([item("home", "Home", "/")], { hasBridge: false });
    renderSwitcher();
    expect(
      screen.getByText(/outside the desktop app/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
  });

  it("surfaces a partial-load error notice even when rows exist", () => {
    setItems([item("home", "Home", "/")], { error: "kaboom" });
    renderSwitcher();
    expect(screen.getByText(/couldn.t load part of your library/i))
      .toBeInTheDocument();
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
    expect(screen.getByText("Home")).toBeInTheDocument();
  });

  it("shows an empty state when there is nothing to switch to", () => {
    setItems([]);
    renderSwitcher();
    expect(screen.getByText(/nothing to switch to yet/i)).toBeInTheDocument();
  });

  it("orders recently-viewed artifacts first on an empty query", () => {
    setItems([
      item("a", "Alpha", "/a"),
      item("b", "Bravo", "/b"),
      item("c", "Charlie", "/c"),
    ]);
    recentIds = ["c"];
    renderSwitcher();
    const options = screen.getAllByRole("option");
    expect(options[0].textContent).toContain("Charlie");
  });
});
