/**
 * Integration coverage for column data validation: a checkbox column
 * renders a toggle that writes TRUE/FALSE, a dropdown column renders a
 * <select> on edit that constrains the value, and an out-of-list value
 * is flagged with an invalid marker.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import SheetEditor from "../editors/SheetEditor";
import type { SheetContent } from "../editors/sheetEditorTypes";

describe("SheetEditor — data validation", () => {
  it("renders a checkbox column and toggles TRUE/FALSE", () => {
    const sheet: SheetContent = {
      columns: ["Done"],
      rows: [[""]],
      validations: { "0": { kind: "checkbox" } },
    };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    const box = screen.getByTestId("sheet-checkbox-0-0") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(
      (screen.getByTestId("sheet-checkbox-0-0") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("renders a dropdown on edit and constrains the value", () => {
    const sheet: SheetContent = {
      columns: ["Status"],
      rows: [["Paid"]],
      validations: { "0": { kind: "list", values: ["Paid", "Unpaid"] } },
    };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    fireEvent.doubleClick(screen.getByTestId("sheet-cell-0-0"));
    const select = screen.getByTestId("sheet-select-0-0") as HTMLSelectElement;
    // The dropdown offers a blank + the two allowed values only.
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["", "Paid", "Unpaid"]);

    fireEvent.change(select, { target: { value: "Unpaid" } });
    expect(screen.getByTestId("sheet-cell-0-0").textContent).toContain(
      "Unpaid",
    );
  });

  it("flags a value that is not in the allowed list", () => {
    const sheet: SheetContent = {
      columns: ["Status"],
      rows: [["Paid"], ["Bogus"]],
      validations: { "0": { kind: "list", values: ["Paid", "Unpaid"] } },
    };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    // Row 0 ("Paid") is valid; row 1 ("Bogus") carries the marker.
    expect(screen.queryByTestId("sheet-dv-invalid-0-0")).toBeNull();
    expect(screen.getByTestId("sheet-dv-invalid-1-0")).toBeInTheDocument();
  });

  it("adds and removes a rule through the panel", () => {
    const sheet: SheetContent = { columns: ["A", "B"], rows: [["", ""]] };
    render(
      <SheetEditor
        content={JSON.stringify(sheet)}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );

    fireEvent.click(screen.getByTestId("sheet-data-validation-toggle"));
    const panel = screen.getByTestId("sheet-dv-panel");

    // Default draft type is dropdown; supply values, then apply.
    fireEvent.change(within(panel).getByLabelText("Dropdown values"), {
      target: { value: "Low, High" },
    });
    fireEvent.click(screen.getByTestId("sheet-dv-add"));
    expect(screen.getByTestId("sheet-dv-row-0")).toBeInTheDocument();

    // The first column now renders as a dropdown on edit.
    fireEvent.doubleClick(screen.getByTestId("sheet-cell-0-0"));
    expect(screen.getByTestId("sheet-select-0-0")).toBeInTheDocument();

    // Remove it again.
    fireEvent.click(
      within(screen.getByTestId("sheet-dv-row-0")).getByText("Remove"),
    );
    expect(screen.queryByTestId("sheet-dv-row-0")).toBeNull();
  });
});
