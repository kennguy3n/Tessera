/**
 * Integration coverage for column sort: right-clicking a column header
 * opens the context menu, and choosing "Sort sheet A → Z / Z → A"
 * reorders the data rows (whole rows move together).
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import SheetEditor from "../editors/SheetEditor";
import type { SheetContent } from "../editors/sheetEditorTypes";

function cellAt(row: number, col: number): HTMLElement {
  const rows = screen
    .getByRole("table")
    .querySelectorAll<HTMLTableRowElement>("tbody tr");
  const tds = rows[row].querySelectorAll<HTMLTableCellElement>("td");
  return tds[col + 1];
}

function colHeader(col: number): HTMLElement {
  const headers = document.querySelectorAll<HTMLElement>(".sheet-col-header");
  return headers[col];
}

describe("SheetEditor — column sort", () => {
  it("sorts the sheet A→Z by a column, moving whole rows", () => {
    const sheet: SheetContent = {
      columns: ["A", "B"],
      rows: [
        ["banana", "2"],
        ["apple", "1"],
        ["cherry", "3"],
      ],
    };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    fireEvent.contextMenu(colHeader(0));
    fireEvent.click(screen.getByTestId("sheet-sort-asc"));

    // Rows moved as units: the "apple" row (and its "1") is now first.
    expect(cellAt(0, 0).textContent).toContain("apple");
    expect(cellAt(0, 1).textContent).toContain("1");
    expect(cellAt(2, 0).textContent).toContain("cherry");
  });

  it("sorts Z→A numerically by a numeric column", () => {
    const sheet: SheetContent = {
      columns: ["A", "B"],
      rows: [
        ["x", "2"],
        ["y", "10"],
        ["z", "1"],
      ],
    };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    fireEvent.contextMenu(colHeader(1));
    fireEvent.click(screen.getByTestId("sheet-sort-desc"));

    // 10 > 2 > 1 numerically (not lexicographically, where "2" > "10").
    expect(cellAt(0, 1).textContent).toContain("10");
    expect(cellAt(1, 1).textContent).toContain("2");
    expect(cellAt(2, 1).textContent).toContain("1");
  });
});
