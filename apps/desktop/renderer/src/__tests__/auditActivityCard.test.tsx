import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import AuditActivityCard from "../components/AuditActivityCard";

const fixtures = [
  {
    id: "ev-5",
    eventType: "KchatConnected",
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    details: "Connected as @alice on https://kchat.example",
  },
  {
    id: "ev-6",
    eventType: "KchatArtifactShared",
    timestamp: new Date(Date.now() - 120_000).toISOString(),
    details: "Shared art-1 to channel chan-1 as pdf",
  },
  {
    id: "ev-7",
    eventType: "ArtifactCreated",
    timestamp: new Date(Date.now() - 200_000).toISOString(),
    details: "Created artifact 'Q4 PRD'",
  },
  {
    id: "ev-8",
    eventType: "SourceAdded",
    timestamp: new Date(Date.now() - 300_000).toISOString(),
    details: "Added /docs",
  },
];

function makeApi(rows = fixtures): typeof window.tessera.audit {
  return {
    listRecent: vi.fn().mockResolvedValue(rows),
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
    // First row is the newest event.
    expect(rows[0]).toHaveTextContent("KchatConnected");
  });

  it("filters to KChat events when the filter pill is clicked", async () => {
    const api = makeApi();
    render(<AuditActivityCard api={api} />);
    await screen.findByTestId("audit-event-list");
    fireEvent.click(screen.getByTestId("audit-filter-kchat"));
    const rows = await screen.findAllByTestId("audit-event-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("KchatConnected");
    expect(rows[1]).toHaveTextContent("KchatArtifactShared");
  });

  it("filters to Sources events when the Sources pill is clicked", async () => {
    const api = makeApi();
    render(<AuditActivityCard api={api} />);
    await screen.findByTestId("audit-event-list");
    fireEvent.click(screen.getByTestId("audit-filter-sources"));
    const rows = await screen.findAllByTestId("audit-event-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("SourceAdded");
  });

  it("shows an empty state when no rows match the active filter", async () => {
    const api = makeApi([]);
    render(<AuditActivityCard api={api} />);
    expect(await screen.findByTestId("audit-empty")).toBeInTheDocument();
  });

  it("surfaces an error when listRecent rejects", async () => {
    const api: typeof window.tessera.audit = {
      listRecent: vi.fn().mockRejectedValue(new Error("db locked")),
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
