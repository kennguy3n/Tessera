/**
 * Component coverage for the slide `chart` block renderer. The geometry
 * is unit-tested in `sheetCharts.test.ts`; here we verify the slide
 * wrapper maps a parsed {@link SlideChartSpec} onto the right SVG marks,
 * renders a legend for multi-series / pie charts, and shows the empty
 * state when there is no plottable data.
 */
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { SlideChart } from "../editors/components/SlideChart";
import { parseSlideChart } from "../editors/slideEditorHelpers";

function renderChart(dsl: string) {
  const spec = parseSlideChart(dsl);
  if (!spec) throw new Error("expected a parseable chart spec");
  return render(
    <SlideChart type={spec.type} data={spec.data} title={spec.title} />,
  );
}

describe("SlideChart", () => {
  it("renders one <rect> per positive bar value", () => {
    const { container } = renderChart(
      "type: bar\nlabels: A, B, C\nX: 10, 20, 30",
    );
    expect(container.querySelectorAll("rect").length).toBe(3);
  });

  it("renders a <polyline> per series for a line chart", () => {
    const { container } = renderChart(
      "type: line\nlabels: A, B, C\nX: 1, 2, 3\nY: 3, 2, 1",
    );
    expect(container.querySelectorAll("polyline").length).toBe(2);
  });

  it("renders one <path> slice per category for a pie chart", () => {
    const { container } = renderChart("type: pie\nlabels: A, B\nX: 3, 7");
    expect(container.querySelectorAll("path").length).toBe(2);
  });

  it("shows a legend for multi-series charts and the figure title", () => {
    const { container, getByText } = renderChart(
      "type: bar\ntitle: Revenue\nlabels: A, B\nFoo: 1, 2\nBar: 3, 4",
    );
    expect(getByText("Revenue")).toBeInTheDocument();
    const legend = container.querySelector(".sheet-chart-legend");
    expect(legend).not.toBeNull();
    expect(legend?.querySelectorAll("li").length).toBe(2);
  });

  it("renders the empty state when there is no numeric data", () => {
    const spec = parseSlideChart("labels: A, B\nX: foo, bar");
    if (!spec) throw new Error("expected a spec");
    const { container, getByRole } = render(
      <SlideChart type={spec.type} data={spec.data} />,
    );
    expect(getByRole("status")).toBeInTheDocument();
    expect(container.querySelector("svg")).toBeNull();
  });
});
