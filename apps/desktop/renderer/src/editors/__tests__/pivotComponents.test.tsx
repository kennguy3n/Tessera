/**
 * Component coverage for the pivot UI shells. The cross-tab maths lives in
 * (and is unit-tested via) `sheetPivot.test.ts`; here we only assert that
 * `SheetPivot` maps a `PivotResult` to accessible table cells and that
 * `PivotPanel` builds a well-formed `PivotSpec` from user input.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PivotPanel } from "../components/PivotPanel";
import { SheetPivot } from "../components/SheetPivot";
import { computePivot } from "../sheetPivot";
import type { PivotSpec } from "../sheetEditorTypes";

/** A 2×2 cross-tab fixture: Region × Quarter, summing Amount. */
const GRID = [
  ["Region", "Quarter", "Amount"],
  ["West", "Q1", "100"],
  ["East", "Q1", "200"],
  ["West", "Q2", "50"],
];
const textAt = (r: number, c: number): string => GRID[r]?.[c] ?? "";
const valueAt = (r: number, c: number): number | null => {
  const n = Number(GRID[r]?.[c]);
  return GRID[r]?.[c] !== "" && Number.isFinite(n) ? n : null;
};

const SPEC: PivotSpec = {
  id: "p1",
  title: "Sales",
  range: "A1:C4",
  rowField: 0,
  colField: 1,
  valueField: 2,
  agg: "sum",
};

describe("SheetPivot", () => {
  it("renders the cross-tab with row/column totals", () => {
    const result = computePivot(SPEC, valueAt, textAt);
    render(
      <SheetPivot spec={SPEC} result={result} onRemove={() => undefined} />,
    );

    // Column headers come from the distinct Quarter values plus a Total.
    expect(screen.getByText("Q1")).toBeInTheDocument();
    expect(screen.getByText("Q2")).toBeInTheDocument();

    // West row: Q1=100, Q2=50, row total 150.
    const westRow = screen.getByText("West").closest("tr") as HTMLElement;
    expect(within(westRow).getByText("100")).toBeInTheDocument();
    expect(within(westRow).getByText("50")).toBeInTheDocument();
    expect(within(westRow).getByText("150")).toBeInTheDocument();

    // Grand total of all amounts.
    expect(screen.getByText("350")).toBeInTheDocument();
  });

  it("shows an empty state when the result has no rows", () => {
    render(
      <SheetPivot
        spec={{ ...SPEC, range: "A1:C1" }}
        result={null}
        onRemove={() => undefined}
      />,
    );
    expect(
      screen.getByTestId(`sheet-pivot-empty-${SPEC.id}`),
    ).toBeInTheDocument();
  });

  it("invokes onRemove when the remove button is clicked", () => {
    const onRemove = vi.fn();
    const result = computePivot(SPEC, valueAt, textAt);
    render(<SheetPivot spec={SPEC} result={result} onRemove={onRemove} />);
    fireEvent.click(screen.getByTestId(`sheet-pivot-remove-${SPEC.id}`));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("shows a specific message when a field's source column was removed", () => {
    // A structural edit collapsed the value field to the -1 sentinel.
    const broken: PivotSpec = { ...SPEC, valueField: -1 };
    render(
      <SheetPivot spec={broken} result={null} onRemove={() => undefined} />,
    );
    expect(
      screen.getByTestId(`sheet-pivot-removed-${broken.id}`),
    ).toHaveTextContent(/source column .* was removed/i);
    // It is distinct from the ordinary "no data" empty state.
    expect(
      screen.queryByTestId(`sheet-pivot-empty-${broken.id}`),
    ).not.toBeInTheDocument();
  });
});

describe("PivotPanel", () => {
  // Encodes both args so tests can assert which header row the panel asked for.
  const columnLabelAt = (c: number, headerRow = 0) => `col-${c}@${headerRow}`;

  it("builds a spec from the range + field pickers", () => {
    const onChange = vi.fn<[PivotSpec[]], void>();
    render(
      <PivotPanel
        pivots={[]}
        columnLabelAt={columnLabelAt}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );

    fireEvent.change(screen.getByTestId("sheet-pivot-range"), {
      target: { value: "A1:C4" },
    });
    // Choose the column field explicitly (defaults leave it None).
    fireEvent.change(screen.getByTestId("sheet-pivot-colfield"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByTestId("sheet-pivot-agg"), {
      target: { value: "average" },
    });
    fireEvent.click(screen.getByTestId("sheet-pivot-add"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const [spec] = onChange.mock.calls[0][0];
    expect(spec).toMatchObject({
      range: "A1:C4",
      rowField: 0,
      colField: 1,
      valueField: 2,
      agg: "average",
    });
    expect(spec.id).toMatch(/^pivot-/);
  });

  it("disables Add until the range parses", () => {
    render(
      <PivotPanel
        pivots={[]}
        columnLabelAt={columnLabelAt}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("sheet-pivot-add")).toBeDisabled();
    fireEvent.change(screen.getByTestId("sheet-pivot-range"), {
      target: { value: "not-a-range" },
    });
    expect(screen.getByTestId("sheet-pivot-add")).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("removes a pivot via its row button", () => {
    const onChange = vi.fn<[PivotSpec[]], void>();
    render(
      <PivotPanel
        pivots={[SPEC]}
        columnLabelAt={columnLabelAt}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );
    fireEvent.click(
      within(screen.getByTestId(`sheet-pivot-row-${SPEC.id}`)).getByRole(
        "button",
        { name: /remove/i },
      ),
    );
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("labels a listed pivot using its own source-range header row", () => {
    // Range starts at row 5 (0-based header row 4), so the label hint must be
    // resolved from row 4 — not the grid's row 0.
    const offset: PivotSpec = { ...SPEC, id: "p2", range: "A5:C20" };
    render(
      <PivotPanel
        pivots={[offset]}
        columnLabelAt={columnLabelAt}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(
      within(screen.getByTestId(`sheet-pivot-row-${offset.id}`)).getByText(
        /col-2@4/,
      ),
    ).toBeInTheDocument();
  });

  it("labels a field whose column was removed as (removed column)", () => {
    const broken: PivotSpec = { ...SPEC, id: "p3", valueField: -1 };
    render(
      <PivotPanel
        pivots={[broken]}
        columnLabelAt={columnLabelAt}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(
      within(screen.getByTestId(`sheet-pivot-row-${broken.id}`)).getByText(
        /\(removed column\)/,
      ),
    ).toBeInTheDocument();
  });
});
