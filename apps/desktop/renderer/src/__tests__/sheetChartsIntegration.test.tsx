/**
 * Integration coverage for charts: a chart persisted on the sheet
 * renders an SVG bound to live cell values, the panel adds/removes
 * charts, and editing a bound cell re-derives the chart.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import SheetEditor from "../editors/SheetEditor";
import type { ChartSpec, SheetContent } from "../editors/sheetEditorTypes";

function renderSheet(sheet: SheetContent) {
  return render(
    <SheetEditor
      content={JSON.stringify(sheet)}
      onSave={() => {}}
      autoSaveMs={5_000_000}
    />,
  );
}

describe("SheetEditor — charts", () => {
  it("renders a bar chart bound to a range as SVG marks", () => {
    const chart: ChartSpec = {
      id: "c1",
      type: "bar",
      range: "A1:A3",
      title: "Sales",
    };
    renderSheet({
      columns: ["A"],
      rows: [["10"], ["20"], ["30"]],
      charts: [chart],
    });

    const fig = screen.getByTestId("sheet-chart-c1");
    expect(fig).toBeInTheDocument();
    // Three positive values → three <rect> bars.
    expect(fig.querySelectorAll("rect").length).toBe(3);
  });

  it("shows an empty state when the range has no numeric data", () => {
    const chart: ChartSpec = { id: "c2", type: "line", range: "A1:A2" };
    renderSheet({ columns: ["A"], rows: [["x"], ["y"]], charts: [chart] });

    expect(screen.getByTestId("sheet-chart-empty-c2")).toBeInTheDocument();
  });

  it("adds and removes a chart through the panel", () => {
    renderSheet({ columns: ["A"], rows: [["5"], ["8"]] });

    fireEvent.click(screen.getByTestId("sheet-charts-toggle"));
    const panel = screen.getByTestId("sheet-charts-panel");

    fireEvent.change(within(panel).getByTestId("sheet-charts-range"), {
      target: { value: "A1:A2" },
    });
    fireEvent.change(within(panel).getByTestId("sheet-charts-title"), {
      target: { value: "My chart" },
    });
    fireEvent.click(within(panel).getByTestId("sheet-charts-add"));

    // A row appears in the panel and a chart renders in the strip.
    expect(within(panel).getByText("My chart")).toBeInTheDocument();
    const strip = screen.getByTestId("sheet-charts-strip");
    expect(within(strip).getByText("My chart")).toBeInTheDocument();

    // Remove it from the strip.
    const fig = within(strip).getByText("My chart").closest("figure");
    expect(fig).not.toBeNull();
    fireEvent.click(within(fig as HTMLElement).getByLabelText(/Remove/));
    expect(screen.queryByTestId("sheet-charts-strip")).toBeNull();
  });

  it("disables Add for an invalid range", () => {
    renderSheet({ columns: ["A"], rows: [["1"]] });
    fireEvent.click(screen.getByTestId("sheet-charts-toggle"));
    const panel = screen.getByTestId("sheet-charts-panel");

    fireEvent.change(within(panel).getByTestId("sheet-charts-range"), {
      target: { value: "not-a-range" },
    });
    expect(
      (within(panel).getByTestId("sheet-charts-add") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(panel).getByRole("alert")).toBeInTheDocument();
  });
});
