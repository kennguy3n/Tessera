import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AppShell, { type AppShellProps } from "../baseviews/appmode/AppShell";
import { makeTableResolver, parseBaseDocument } from "../baseDocumentHelpers";
import type { BaseAppConfig, BaseDocument } from "../baseEditorTypes";

function makeDoc(): BaseDocument {
  return parseBaseDocument(
    JSON.stringify({
      fields: [
        { name: "Name", type: "text" },
        { name: "Stage", type: "select", options: ["Lead", "Won"] },
      ],
      records: [{ id: "r1", Name: "Acme", Stage: "Lead" }],
    }),
  );
}

function props(doc: BaseDocument, app: BaseAppConfig): AppShellProps {
  const table = doc.tables[0];
  return {
    doc,
    app,
    activeTableId: doc.activeTableId,
    data: { fields: table.fields, records: table.records },
    resolver: makeTableResolver(doc),
    onSwitchTable: vi.fn(),
    onUpdateCell: vi.fn(),
    onAddRecordWith: vi.fn(),
    onRemoveRecord: vi.fn(),
    onAppConfigChange: vi.fn(),
    onExitAppMode: vi.fn(),
  };
}

describe("AppShell nav highlight", () => {
  it("re-points the highlight to the dashboard when the selected page disappears", async () => {
    const user = userEvent.setup();
    const doc = makeDoc();
    const t0 = doc.tables[0].id;
    const withForm: BaseAppConfig = {
      name: "CRM",
      forms: [{ id: "f1", name: "Intake", tableId: t0, fieldNames: ["Name"] }],
      dashboard: { widgets: [] },
    };
    const { rerender } = render(<AppShell {...props(doc, withForm)} />);

    // Select the form page — its nav link becomes the current one.
    await user.click(screen.getByTestId("base-app-nav-form"));
    expect(screen.getByTestId("base-app-nav-form")).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByTestId("base-app-nav-dashboard")).not.toHaveAttribute(
      "aria-current",
    );

    // Remove the form (e.g. deleted elsewhere) so the selected page vanishes.
    const withoutForm: BaseAppConfig = {
      ...withForm,
      forms: [],
    };
    rerender(<AppShell {...props(doc, withoutForm)} />);

    // The form link is gone and the highlight self-heals onto the
    // dashboard (the fallback page actually shown) rather than leaving
    // no nav entry marked current.
    expect(screen.queryByTestId("base-app-nav-form")).not.toBeInTheDocument();
    expect(screen.getByTestId("base-app-nav-dashboard")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
});
