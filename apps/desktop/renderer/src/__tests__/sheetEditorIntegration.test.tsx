/**
 * SheetEditor formula-engine integration test.
 *
 * Mounts the real `SheetEditor` component (no mocking of the
 * engine itself) and exercises the live edit / formula / formula
 * bar wiring end-to-end:
 *
 *   1. A pre-populated sheet with `A1=1, A2=2, A3=3, B1=SUM(A1:A3)`
 *      renders `6` in B1.
 *   2. Editing A3 from `3` to `10` causes B1 to re-render as `13`.
 *   3. Clicking a cell mirrors its raw text (including the leading
 *      `=`) into the formula bar — Excel's standard UX.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import SheetEditor from "../editors/SheetEditor";
import type { SheetContent } from "../editors/sheetEditorTypes";

function makeContent(sheet: SheetContent): string {
  return JSON.stringify(sheet);
}

function cellAt(row: number, col: number): HTMLElement {
  // <tbody> rows are zero-indexed; each row has an extra leading
  // <td> for the row number, so logical col 0 is the second <td>.
  const rows = screen
    .getByRole("table")
    .querySelectorAll<HTMLTableRowElement>("tbody tr");
  const tr = rows[row];
  const tds = tr.querySelectorAll<HTMLTableCellElement>("td");
  return tds[col + 1];
}

describe("SheetEditor — formula engine integration", () => {
  it("renders a SUM formula's evaluated value", () => {
    const sheet: SheetContent = {
      columns: ["A", "B"],
      rows: [
        ["1", "=SUM(A1:A3)"],
        ["2", ""],
        ["3", ""],
      ],
    };
    render(
      <SheetEditor
        content={makeContent(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    // B1 shows 6 (1+2+3).
    expect(within(cellAt(0, 1)).getByText("6")).toBeInTheDocument();
  });

  it("re-evaluates dependents when a source cell changes", () => {
    const onSave = vi.fn();
    const sheet: SheetContent = {
      columns: ["A", "B"],
      rows: [
        ["1", "=SUM(A1:A3)"],
        ["2", ""],
        ["3", ""],
      ],
    };
    render(
      <SheetEditor
        content={makeContent(sheet)}
        onSave={onSave}
        // Tiny debounce so the test isn't tied to wall-clock.
        autoSaveMs={5_000_000}
      />,
    );

    // Double-click A3 to edit, change to 10, press Enter.
    const a3 = cellAt(2, 0);
    fireEvent.doubleClick(a3);
    const input = screen
      .getAllByRole("textbox")
      .find((el) =>
        el.classList.contains("sheet-cell-input"),
      ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "10" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // B1 should re-render as 13 (1 + 2 + 10).
    expect(within(cellAt(0, 1)).getByText("13")).toBeInTheDocument();
  });

  it("surfaces the active cell's raw formula in the formula bar", () => {
    const sheet: SheetContent = {
      columns: ["A", "B"],
      rows: [
        ["1", "=SUM(A1:A3)"],
        ["2", ""],
        ["3", ""],
      ],
    };
    render(
      <SheetEditor
        content={makeContent(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    const bar = screen.getByTestId(
      "sheet-formula-bar-input",
    ) as HTMLInputElement;
    expect(bar.value).toBe("");

    fireEvent.click(cellAt(0, 1)); // B1
    expect(bar.value).toBe("=SUM(A1:A3)");
    expect(screen.getByTestId("sheet-formula-bar-address")).toHaveTextContent(
      "B1",
    );

    fireEvent.click(cellAt(2, 0)); // A3
    expect(bar.value).toBe("3");
    expect(screen.getByTestId("sheet-formula-bar-address")).toHaveTextContent(
      "A3",
    );
  });

  it("commits an edit typed into the formula bar", () => {
    const sheet: SheetContent = {
      columns: ["A", "B"],
      rows: [
        ["1", "=A1*2"],
        ["", ""],
      ],
    };
    render(
      <SheetEditor
        content={makeContent(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    // Activate A1, then type a new formula into the bar.
    fireEvent.click(cellAt(0, 0));
    const bar = screen.getByTestId(
      "sheet-formula-bar-input",
    ) as HTMLInputElement;
    fireEvent.change(bar, { target: { value: "5" } });
    fireEvent.keyDown(bar, { key: "Enter" });

    // B1's =A1*2 should now display 10.
    expect(within(cellAt(0, 1)).getByText("10")).toBeInTheDocument();
  });

  it("renders a formula error code without crashing", () => {
    const sheet: SheetContent = {
      columns: ["A"],
      rows: [["=1/0"]],
    };
    render(
      <SheetEditor
        content={makeContent(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    expect(within(cellAt(0, 0)).getByText("#DIV/0!")).toBeInTheDocument();
  });
});
