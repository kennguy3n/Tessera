import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import AuditActivityCard from "../components/AuditActivityCard";

// The Rust `AuditEventType` enum uses `#[serde(rename_all =
// "snake_case")]`, so the napi bridge emits strings like
// `"kchat_connected"`, `"artifact_created"`, etc. These fixtures
// mirror the production wire format so the filter prefixes are
// exercised against the same input shape the renderer sees in
// release builds.
const fixtures = [
  {
    id: "ev-5",
    eventType: "kchat_connected",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    details: "Connected as @alice on https://kchat.example",
  },
  {
    id: "ev-6",
    eventType: "kchat_artifact_shared",
    timestamp: new Date(Date.now() - 120_000).toISOString(),
    details: "Shared art-1 to channel chan-1 as pdf",
  },
  {
    id: "ev-7",
    eventType: "artifact_created",
    timestamp: new Date(Date.now() - 200_000).toISOString(),
    details: "Created artifact 'Q4 PRD'",
  },
  {
    id: "ev-8",
    eventType: "source_added",
    timestamp: new Date(Date.now() - 300_000).toISOString(),
    details: "Added /docs",
  },
];

function makeApi(rows = fixtures): typeof window.tessera.audit {
  return {
    listRecent: vi.fn().mockResolvedValue(rows),
    // Phase 15 Task 12: rotation/archive endpoints exist on the
    // API surface but are not exercised by this component. Stub
    // them with empty returns so the type-checker sees a complete
    // AuditApi shape — production behaviour is covered by the
    // dedicated rotation tests in `tessera_audit::store::tests`.
    getArchives: vi.fn().mockResolvedValue([]),
    rotate: vi.fn().mockResolvedValue(null),
  };
}

beforeEach(() => {
  // no-op
});

describe("AuditActivityCard", () => {
  it("loads and renders all events newest-first", async () => {
    const api = makeApi();
    render(<AuditActivityCard api={api} />);
    await screen.findByTestId("audit-event-list");
    expect(api.listRecent).toHaveBeenCalledWith(100, 0);
    const rows = await screen.findAllByTestId("audit-event-row");
    expect(rows).toHaveLength(fixtures.length);
    // First row is the newest event (rendered as a humanized label).
    expect(rows[0]).toHaveTextContent("KChat Connected");
  });

  it("filters to KChat events when the filter pill is clicked", async () => {
    const api = makeApi();
    render(<AuditActivityCard api={api} />);
    await screen.findByTestId("audit-event-list");
    fireEvent.click(screen.getByTestId("audit-filter-kchat"));
    const rows = await screen.findAllByTestId("audit-event-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("KChat Connected");
    expect(rows[1]).toHaveTextContent("KChat Artifact Shared");
  });

  it("filters to Sources events when the Sources pill is clicked", async () => {
    const api = makeApi();
    render(<AuditActivityCard api={api} />);
    await screen.findByTestId("audit-event-list");
    fireEvent.click(screen.getByTestId("audit-filter-sources"));
    const rows = await screen.findAllByTestId("audit-event-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Source Added");
  });

  it("shows an empty state when no rows match the active filter", async () => {
    const api = makeApi([]);
    render(<AuditActivityCard api={api} />);
    expect(await screen.findByTestId("audit-empty")).toBeInTheDocument();
  });

  it("surfaces an error when listRecent rejects", async () => {
    const api: typeof window.tessera.audit = {
      listRecent: vi.fn().mockRejectedValue(new Error("db locked")),
      getArchives: vi.fn().mockResolvedValue([]),
      rotate: vi.fn().mockResolvedValue(null),
    };
    render(<AuditActivityCard api={api} />);
    expect(await screen.findByTestId("audit-error")).toHaveTextContent("db locked");
  });

  it("refresh re-fetches when the Refresh button is clicked", async () => {
    const api = makeApi();
    render(<AuditActivityCard api={api} />);
    await screen.findByTestId("audit-event-list");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(api.listRecent).toHaveBeenCalledTimes(2));
  });
});
