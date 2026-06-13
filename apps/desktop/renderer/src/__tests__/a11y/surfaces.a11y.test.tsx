/**
 * Automated accessibility audit — major interactive surfaces.
 *
 * Complements `pages.a11y.test.tsx` (which owns the top-level routes) by
 * auditing the heavy, stateful widgets the user spends most of their
 * time in: the command palette, quick switcher, a representative modal
 * dialog, the concept graph, and all four artifact editors. Each is
 * rendered in its open / active state inside the real application shell
 * landmarks (a `<main>` plus the page `<h1>` every surface can assume is
 * present) and audited with the shared WCAG 2.1 AA rule set.
 *
 * Modals render their own `role="dialog"` and are audited directly;
 * `ComparisonResultModal` / `ShareToKchatModal` are thin wrappers around
 * the same `Modal` primitive audited here, so the dialog/focus-trap
 * contract they inherit is covered by the generic-modal case.
 *
 * Color-contrast is not decided in jsdom (no paint) — see `axeHelper.ts`
 * and the browser pass in `qa/a11y.spec.ts`.
 */
import { describe, it, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement } from "react";

import { ToastProvider } from "../../components/Toast";
import WorkspaceProvider from "../../workspace/WorkspaceProvider";
import { expectNoA11yViolations } from "./axeHelper";

import CommandPalette from "../../components/CommandPalette";
import QuickSwitcher from "../../components/QuickSwitcher";
import Modal from "../../components/Modal";
import Button from "../../components/Button";
import ConceptGraphPanel from "../../components/ConceptGraphPanel";
import DocumentEditor from "../../editors/DocumentEditor";
import SheetEditor from "../../editors/SheetEditor";
import SlideEditor from "../../editors/SlideEditor";
import BaseEditor from "../../editors/BaseEditor";
import type { SubstrateMemoryInfo } from "../../types/ipc";

// The quick switcher aggregates the live artifact/source/template/task
// lists over IPC; that async plumbing is exercised by its own dedicated
// suite. Here we only audit its open chrome, so feed it a small,
// deterministic item set (and stable loading flags) rather than driving
// the bridge — keeping the a11y assertion independent of fetch timing.
vi.mock("../../hooks/useQuickSwitcherItems", () => ({
  useQuickSwitcherItems: () => ({
    items: [
      {
        id: "artifact:a1",
        kind: "artifact",
        title: "Q3 Board Deck",
        subtitle: "Artifact · slide",
        keywords: "slide",
        to: "/artifact/a1",
      },
      {
        id: "source:s1",
        kind: "source",
        title: "Finance Drive",
        subtitle: "Source · gdrive",
        keywords: "gdrive",
        to: "/sources/s1",
      },
    ],
    loading: false,
    error: null,
    hasBridge: true,
    refreshAll: vi.fn(),
  }),
}));

/**
 * Mount an interactive surface inside the real shell landmarks. A
 * visually-hidden `<h1>` stands in for the host page's title so the
 * audited subtree has the same heading context it does in production
 * (the surfaces themselves open from within a page that always renders
 * one), keeping `page-has-heading-one` / `heading-order` honest without
 * suppressing them.
 */
function renderSurface(ui: ReactElement): RenderResult {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <WorkspaceProvider>
          <h1 className="sr-only">Workspace</h1>
          <main className="app-main">{ui}</main>
        </WorkspaceProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const GRAPH_JSON = JSON.stringify({
  nodes: [
    {
      id: "atlas",
      label: "Atlas",
      state: "Canonical",
      scope_id: "scope-a",
      connections_count: 1,
    },
    {
      id: "beacon",
      label: "Beacon",
      state: "candidate",
      scope_id: "scope-a",
      connections_count: 1,
    },
  ],
  edges: [
    {
      id: "e1",
      from: "atlas",
      to: "beacon",
      relation_type: "is_a",
      scope_id: "scope-a",
    },
  ],
  scope_filter: [],
  depth: 2,
  truncation: "complete",
});

const GRAPH_EVIDENCE: SubstrateMemoryInfo[] = [
  {
    id: "mem-1",
    scopeId: "scope-a",
    observationType: "entity",
    content: "Atlas is the internal codename for the project",
    state: "canonical",
    retentionScore: 0.9,
    pinCount: 1,
    retrievalCount: 3,
    corroborationCount: 2,
    createdAt: 0,
    lastAccessedAt: 0,
    sourceId: "src-123456",
  },
];

const SHEET_CONTENT = JSON.stringify({
  columns: ["Region", "Revenue"],
  rows: [
    ["North", "1200"],
    ["South", "980"],
  ],
});

const SLIDE_CONTENT = JSON.stringify({
  theme: "default",
  slides: [
    {
      id: "s1",
      title: "Alpha",
      layout: "title-content",
      blocks: [{ type: "text", content: "alpha body" }],
      notes: "",
    },
    {
      id: "s2",
      title: "Beta",
      layout: "title-content",
      blocks: [{ type: "text", content: "beta body" }],
      notes: "",
    },
  ],
});

const BASE_CONTENT = JSON.stringify({
  tables: [
    {
      id: "t1",
      name: "Vendors",
      fields: [
        { id: "f1", name: "Name", type: "text" },
        { id: "f2", name: "Active", type: "checkbox" },
      ],
      rows: [{ id: "r1", cells: { f1: "Acme", f2: true } }],
    },
  ],
  activeTableId: "t1",
});

describe("Accessibility — interactive surfaces", () => {
  beforeEach(() => {
    // Several surfaces read `prefers-reduced-motion` via `matchMedia` in a
    // `useState` initializer at mount, so it must always return a valid
    // MediaQueryList (jsdom provides none). Assign unconditionally — a
    // prior test may have left a stub that returns `undefined`.
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.localStorage.clear();
  });

  afterEach(() => {
    // Only clear call history. `restoreAllMocks()` would reset the
    // shared `window.tessera` bridge stubs (installed once in setup.ts)
    // to no-op `vi.fn()`s that resolve `undefined`, which then crashes
    // later tests whose hooks expect arrays / settings objects from the
    // bridge (e.g. `settings.recentArtifactIds`, the artifact list).
    vi.clearAllMocks();
  });

  it("Command palette (open) has no structural a11y violations", async () => {
    const { container } = renderSurface(
      <CommandPalette isOpen onClose={() => {}} />,
    );
    await screen.findByRole("dialog", { name: /command palette/i });
    await expectNoA11yViolations(container);
  });

  it("Quick switcher (open) has no structural a11y violations", async () => {
    const { container } = renderSurface(
      <QuickSwitcher isOpen onClose={() => {}} />,
    );
    await screen.findByRole("dialog");
    await expectNoA11yViolations(container);
  });

  it("Modal dialog (open, with a form) has no structural a11y violations", async () => {
    const { container } = renderSurface(
      <Modal isOpen onClose={() => {}} title="Rename workspace">
        <form>
          <label htmlFor="ws-name">Workspace name</label>
          <input id="ws-name" name="ws-name" type="text" defaultValue="Atlas" />
          <div>
            <Button variant="secondary" onClick={() => {}}>
              Cancel
            </Button>
            <Button onClick={() => {}}>Save</Button>
          </div>
        </form>
      </Modal>,
    );
    await screen.findByRole("dialog", { name: /rename workspace/i });
    await expectNoA11yViolations(container);
  });

  it("Concept graph (populated) has no structural a11y violations", async () => {
    window.tessera.substrate.getConceptGraph = vi
      .fn()
      .mockResolvedValue(GRAPH_JSON);
    const { container } = renderSurface(
      <ConceptGraphPanel memories={GRAPH_EVIDENCE} />,
    );
    await waitFor(() => {
      if (screen.queryAllByText(/^loading/i).length > 0) {
        throw new Error("still loading");
      }
    });
    await expectNoA11yViolations(container);
  });

  it("Document editor has no structural a11y violations", async () => {
    const { container } = renderSurface(
      <DocumentEditor content="# Heading\n\nA paragraph." onSave={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });

  it("Sheet editor has no structural a11y violations", async () => {
    const { container } = renderSurface(
      <SheetEditor
        content={SHEET_CONTENT}
        onSave={() => {}}
        autoSaveMs={5_000_000}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("Slide editor has no structural a11y violations", async () => {
    const { container } = renderSurface(
      <SlideEditor content={SLIDE_CONTENT} onSave={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });

  it("Base editor has no structural a11y violations", async () => {
    const { container } = renderSurface(
      <BaseEditor content={BASE_CONTENT} onSave={() => {}} />,
    );
    await expectNoA11yViolations(container);
  });
});
