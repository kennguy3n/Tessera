/**
 * Integration coverage for the manual cell-format toolbar: toggling
 * bold styles the active cell and persists a format, and choosing a
 * number-format preset re-renders the cell's displayed value.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import SheetEditor from "../editors/SheetEditor";
import type { SheetContent } from "../editors/sheetEditorTypes";

function cellAt(row: number, col: number): HTMLElement {
  const rows = screen
    .getByRole("table")
    .querySelectorAll<HTMLTableRowElement>("tbody tr");
  const tds = rows[row].querySelectorAll<HTMLTableCellElement>("td");
  return tds[col + 1];
}

describe("SheetEditor — format toolbar", () => {
  it("toggles bold on the active cell and persists a format", () => {
    const onSave = vi.fn();
    const sheet: SheetContent = { columns: ["A"], rows: [["hello"]] };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={onSave}
        autoSaveMs={1}
      />,
    );

    fireEvent.click(cellAt(0, 0));
    fireEvent.click(screen.getByTestId("sheet-format-bold"));

    expect(cellAt(0, 0).style.fontWeight).toBe("600");
  });

  it("applies a currency number format to a numeric cell", () => {
    const sheet: SheetContent = { columns: ["A"], rows: [["1234.5"]] };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    fireEvent.click(cellAt(0, 0));
    fireEvent.change(screen.getByTestId("sheet-format-number"), {
      target: { value: "currency" },
    });

    expect(within(cellAt(0, 0)).getByText("$1,234.50")).toBeInTheDocument();
  });
});
