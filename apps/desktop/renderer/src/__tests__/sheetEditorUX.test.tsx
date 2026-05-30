/**
 * Phase 16 PR 3 — SheetEditor UX integration tests.
 *
 * Covers Tasks 16-20 in a single file because they share fixture
 * setup (mounted editor + grid traversal helper). Each describe()
 * block is one task.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import SheetEditor from "../editors/SheetEditor";
import type { SheetContent } from "../editors/sheetEditorTypes";

function makeContent(sheet: SheetContent): string {
  return JSON.stringify(sheet);
}

function cellAt(row: number, col: number): HTMLElement {
  const rows = screen
    .getByRole("table")
    .querySelectorAll<HTMLTableRowElement>("tbody tr");
  const tr = rows[row];
  const tds = tr.querySelectorAll<HTMLTableCellElement>("td");
  return tds[col + 1];
}

function grid(): HTMLElement {
  return screen
    .getByRole("table")
    .closest(".sheet-grid-wrapper") as HTMLElement;
}

const basicSheet: SheetContent = {
  columns: ["A", "B", "C"],
  rows: [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
  ],
};

describe("SheetEditor UX — Task 17 selection", () => {
  it("shift+click extends the primary range", () => {
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    fireEvent.click(cellAt(0, 0)); // anchor at A1
    fireEvent.click(cellAt(1, 1), { shiftKey: true }); // extend to B2
    // Every cell in the 2x2 rectangle is marked .selected
    expect(cellAt(0, 0).className).toContain("selected");
    expect(cellAt(0, 1).className).toContain("selected");
    expect(cellAt(1, 0).className).toContain("selected");
    expect(cellAt(1, 1).className).toContain("selected");
    // C1, A3, etc. are NOT selected
    expect(cellAt(0, 2).className).not.toContain("selected");
  });

  it("ctrl+click adds a disjoint extra to the selection", () => {
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    fireEvent.click(cellAt(0, 0));
    fireEvent.click(cellAt(2, 2), { ctrlKey: true });
    expect(cellAt(0, 0).className).toContain("selected");
    expect(cellAt(2, 2).className).toContain("selected");
    // anchor cell stays unchanged
    const address = screen.getByTestId("sheet-formula-bar-address");
    expect(address).toHaveTextContent("A1");
  });

  it("arrow key navigates the active cell when not editing", () => {
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    fireEvent.click(cellAt(0, 0));
    const wrapper = grid();
    fireEvent.keyDown(wrapper, { key: "ArrowRight" });
    expect(screen.getByTestId("sheet-formula-bar-address")).toHaveTextContent(
      "B1",
    );
    fireEvent.keyDown(wrapper, { key: "ArrowDown" });
    expect(screen.getByTestId("sheet-formula-bar-address")).toHaveTextContent(
      "B2",
    );
  });

  it("Delete key clears every cell in the current selection", () => {
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    fireEvent.click(cellAt(0, 0));
    fireEvent.click(cellAt(1, 1), { shiftKey: true });
    fireEvent.keyDown(grid(), { key: "Delete" });
    expect(within(cellAt(0, 0)).queryByText("1")).toBeNull();
    expect(within(cellAt(0, 1)).queryByText("2")).toBeNull();
    expect(within(cellAt(1, 0)).queryByText("4")).toBeNull();
    expect(within(cellAt(1, 1)).queryByText("5")).toBeNull();
    // C1 still has 3
    expect(within(cellAt(0, 2)).getByText("3")).toBeInTheDocument();
  });
});

describe("SheetEditor UX — Task 16 column/row resize", () => {
  it("dragging a column resize handle updates the column width", () => {
    const onSave = vi.fn();
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={onSave}
        autoSaveMs={0}
      />,
    );
    const handle = screen.getByTestId("sheet-col-resize-0");
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 180 });
    fireEvent.mouseUp(window);
    // First column header now has an inline width style ≥ default+80
    const headers = screen
      .getByRole("table")
      .querySelectorAll<HTMLTableCellElement>("thead th");
    // header[0] is the row-number # column; header[1] is column A
    const styledWidth = parseInt(headers[1].style.width || "0", 10);
    expect(styledWidth).toBeGreaterThanOrEqual(170);
  });

  it("dragging a row resize handle updates the row height", () => {
    const onSave = vi.fn();
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={onSave}
        autoSaveMs={0}
      />,
    );
    const handle = screen.getByTestId("sheet-row-resize-0");
    fireEvent.mouseDown(handle, { clientY: 50 });
    fireEvent.mouseMove(window, { clientY: 120 });
    fireEvent.mouseUp(window);
    const tr = screen
      .getByRole("table")
      .querySelectorAll<HTMLTableRowElement>("tbody tr")[0];
    const styledHeight = parseInt(tr.style.height || "0", 10);
    expect(styledHeight).toBeGreaterThanOrEqual(80);
  });
});

describe("SheetEditor UX — Task 19 freeze rows/cols", () => {
  it("right-clicking a column header opens the freeze menu", () => {
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    const headers = screen
      .getByRole("table")
      .querySelectorAll<HTMLTableCellElement>("thead th");
    fireEvent.contextMenu(headers[1], { clientX: 50, clientY: 50 });
    const menu = screen.getByTestId("sheet-context-menu");
    expect(menu).toBeInTheDocument();
    expect(menu.textContent).toContain("Freeze up to this column");
  });

  it("clicking the freeze item persists frozenCols in onSave", async () => {
    const onSave = vi.fn();
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={onSave}
        autoSaveMs={0}
      />,
    );
    const headers = screen
      .getByRole("table")
      .querySelectorAll<HTMLTableCellElement>("thead th");
    fireEvent.contextMenu(headers[1], { clientX: 50, clientY: 50 });
    const item = within(screen.getByTestId("sheet-context-menu")).getByText(
      /Freeze up to this column/i,
    );
    fireEvent.click(item);
    // Wait a microtask for the debounced save to flush.
    await new Promise((r) => setTimeout(r, 5));
    expect(onSave).toHaveBeenCalled();
    const lastCall = onSave.mock.calls[onSave.mock.calls.length - 1][0];
    const saved = JSON.parse(lastCall);
    expect(saved.frozenCols).toBe(1);
  });
});

describe("SheetEditor UX — Task 18 copy/paste", () => {
  let writeMock: ReturnType<typeof vi.fn>;
  let readMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeMock = vi.fn().mockResolvedValue(undefined);
    readMock = vi.fn().mockResolvedValue("X\tY\nZ\tW");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeMock, readText: readMock },
    });
  });

  it("ctrl+c writes selection TSV to the system clipboard", async () => {
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    fireEvent.click(cellAt(0, 0));
    fireEvent.click(cellAt(1, 1), { shiftKey: true });
    // Focus the grid wrapper so the document-level handler treats
    // it as the active scope.
    (grid() as HTMLElement).focus();
    fireEvent.keyDown(document, { key: "c", ctrlKey: true });
    // Allow the microtask to flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(writeMock).toHaveBeenCalledTimes(1);
    expect(writeMock.mock.calls[0][0]).toBe("1\t2\n4\t5");
  });

  it("ctrl+v reads from the clipboard and pastes at the anchor", async () => {
    const onSave = vi.fn();
    render(
      <SheetEditor
        content={makeContent(basicSheet)}
        onSave={onSave}
        autoSaveMs={0}
      />,
    );
    fireEvent.click(cellAt(0, 0)); // anchor A1
    (grid() as HTMLElement).focus();
    fireEvent.keyDown(document, { key: "v", ctrlKey: true });
    // readText is async + paste schedules a setSheet; flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(readMock).toHaveBeenCalledTimes(1);
    expect(within(cellAt(0, 0)).getByText("X")).toBeInTheDocument();
    expect(within(cellAt(1, 1)).getByText("W")).toBeInTheDocument();
  });
});

describe("SheetEditor UX — Task 20 auto-fill", () => {
  it("drag from fill handle extends a numeric series down", () => {
    const onSave = vi.fn();
    render(
      <SheetEditor
        content={makeContent({
          columns: ["A"],
          rows: [["1"], ["2"], [""], [""], [""]],
        })}
        onSave={onSave}
        autoSaveMs={0}
      />,
    );
    fireEvent.click(cellAt(0, 0));
    fireEvent.click(cellAt(1, 0), { shiftKey: true });
    // Auto-fill handle lives at the bottom-right of the selection.
    const handle = screen.getByTestId("sheet-fill-handle-1-0");
    fireEvent.mouseDown(handle, { clientX: 0, clientY: 0 });
    // Synthesize a hover on row 4 by elementFromPoint stubbing:
    // we substitute the document API for the duration.
    const target = cellAt(4, 0);
    const realFn = document.elementFromPoint;
    document.elementFromPoint = vi.fn().mockReturnValue(target);
    fireEvent.mouseMove(window, { clientX: 0, clientY: 100 });
    fireEvent.mouseUp(window);
    document.elementFromPoint = realFn;
    expect(within(cellAt(2, 0)).getByText("3")).toBeInTheDocument();
    expect(within(cellAt(3, 0)).getByText("4")).toBeInTheDocument();
    expect(within(cellAt(4, 0)).getByText("5")).toBeInTheDocument();
  });
});
