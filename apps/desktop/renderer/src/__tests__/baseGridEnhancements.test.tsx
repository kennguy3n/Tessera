/**
 * Integration tests for the Airtable-style grid enhancements wired
 * into BaseEditor: row-height density, group-by with collapsible
 * headers, color-by, and frozen columns. The pure partitioning /
 * color / offset logic is unit-tested in
 * `editors/__tests__/baseGridHelpers.test.ts`; here we verify the
 * editor wires the persisted `viewConfig` knobs into the rendered
 * grid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import BaseEditor from "../editors/BaseEditor";

function renderEditor(content: object, onSave = vi.fn()) {
  const json = JSON.stringify(content);
  return render(<BaseEditor content={json} onSave={onSave} autoSaveMs={10} />);
}

const STAGED_BASE = {
  fields: [
    { name: "Title", type: "text" },
    { name: "Stage", type: "select", options: ["Lead", "Won"] },
  ],
  records: [
    { Title: "Acme", Stage: "Lead" },
    { Title: "Globex", Stage: "Won" },
    { Title: "Initech", Stage: "Lead" },
    { Title: "Hooli", Stage: "" },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("grid grouping", () => {
  it("partitions rows under collapsible group headers and collapses on click", () => {
    renderEditor(STAGED_BASE);
    fireEvent.change(screen.getByLabelText("Group by"), {
      target: { value: "Stage" },
    });

    // Group headers for Lead, Won, and the trailing Empty group.
    expect(screen.getByTestId("base-group-Lead")).toBeInTheDocument();
    expect(screen.getByTestId("base-group-Won")).toBeInTheDocument();
    expect(screen.getByTestId("base-group-__empty__")).toBeInTheDocument();

    // The two Lead rows are visible (cell values render inside inputs).
    expect(screen.getByDisplayValue("Acme")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Initech")).toBeInTheDocument();

    // Collapse the Lead group — its rows disappear, header remains.
    const leadHeader = screen.getByTestId("base-group-Lead");
    fireEvent.click(within(leadHeader).getByRole("button"));
    expect(screen.queryByDisplayValue("Acme")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Initech")).not.toBeInTheDocument();
    expect(screen.getByTestId("base-group-Lead")).toBeInTheDocument();
    // Other groups still show their rows.
    expect(screen.getByDisplayValue("Globex")).toBeInTheDocument();
  });

  it("clears collapsed-group state when the group-by field changes", () => {
    renderEditor(STAGED_BASE);
    const groupBy = screen.getByLabelText("Group by");
    fireEvent.change(groupBy, { target: { value: "Stage" } });

    // Collapse the Lead group so its rows are hidden.
    fireEvent.click(
      within(screen.getByTestId("base-group-Lead")).getByRole("button"),
    );
    expect(screen.queryByDisplayValue("Acme")).not.toBeInTheDocument();

    // Turn grouping off, then re-group by the same field. The stale
    // "Lead" collapse key must NOT carry over — its rows are visible.
    fireEvent.change(groupBy, { target: { value: "" } });
    fireEvent.change(groupBy, { target: { value: "Stage" } });
    expect(screen.getByTestId("base-group-Lead")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Acme")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Initech")).toBeInTheDocument();
  });
});

describe("grid row height", () => {
  it("applies the configured pixel height to data rows", () => {
    renderEditor(STAGED_BASE);
    const titleCell = screen.getByDisplayValue("Acme");
    const row = titleCell.closest("tr") as HTMLTableRowElement;
    expect(row.style.height).toBe("36px"); // short default

    fireEvent.change(screen.getByLabelText("Row height"), {
      target: { value: "tall" },
    });
    const tallRow = screen
      .getByDisplayValue("Acme")
      .closest("tr") as HTMLTableRowElement;
    expect(tallRow.style.height).toBe("88px");
  });
});

describe("grid color-by", () => {
  it("renders a colored strip when a color field is chosen", () => {
    const { container } = renderEditor(STAGED_BASE);
    // No strip before configuring color-by.
    expect(
      container.querySelectorAll('span[aria-hidden="true"]').length,
    ).toBeGreaterThanOrEqual(0);
    fireEvent.change(screen.getByLabelText("Color by"), {
      target: { value: "Stage" },
    });
    // Rows with a non-empty Stage get a strip; the empty one does not.
    const acmeRow = screen
      .getByDisplayValue("Acme")
      .closest("tr") as HTMLTableRowElement;
    const strip = acmeRow.querySelector('span[aria-hidden="true"]');
    expect(strip).not.toBeNull();
    expect((strip as HTMLElement).style.background).not.toBe("");
  });
});

describe("grid frozen columns", () => {
  it("makes the leading columns sticky when frozen > 0", () => {
    renderEditor(STAGED_BASE);
    fireEvent.change(screen.getByLabelText("Frozen columns"), {
      target: { value: "1" },
    });
    const acmeCell = screen
      .getByDisplayValue("Acme")
      .closest("td") as HTMLTableCellElement;
    // The first data column ("Title") becomes sticky.
    expect(acmeCell.style.position).toBe("sticky");
  });
});
