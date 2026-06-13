import {
  useState,
  useMemo,
  useRef,
  useEffect,
  useCallback,
  useLayoutEffect,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutTemplate,
  SearchX,
  FileText,
  Presentation,
  Table as TableIcon,
  Database,
} from "lucide-react";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import SearchInput from "../components/SearchInput";
import EmptyState from "../components/EmptyState";
import { useTemplateList } from "../hooks/useTemplates";

interface TemplateCardData {
  id: string;
  name: string;
  description: string;
  type: string;
}

const BUILTIN_TEMPLATES: TemplateCardData[] = [
  { id: "prd-v1", name: "PRD", description: "Product Requirements Document with problem, solution, scope, and success criteria", type: "document" },
  { id: "proposal-v1", name: "Proposal", description: "Business or project proposal with executive summary and budget", type: "document" },
  { id: "sop-v1", name: "SOP", description: "Standard Operating Procedure with step-by-step instructions", type: "document" },
  { id: "report-v1", name: "Report", description: "Analytical report with findings and recommendations", type: "document" },
  { id: "memo-v1", name: "Memo", description: "Internal communication memo with context and action items", type: "document" },
  { id: "qbr-v1", name: "QBR", description: "Quarterly Business Review with metrics and next quarter plan", type: "slides" },
  { id: "strategy-v1", name: "Strategy Deck", description: "Strategic planning with vision, market analysis, and roadmap", type: "slides" },
  { id: "review-v1", name: "Review", description: "Project or performance review with status and next steps", type: "slides" },
  { id: "budget-v1", name: "Budget", description: "Budget spreadsheet with categories and variance analysis", type: "sheet" },
  { id: "scorecard-v1", name: "Scorecard", description: "Performance scorecard with KPIs and targets", type: "sheet" },
  { id: "roadmap-v1", name: "Roadmap", description: "Product or project roadmap with phases and milestones", type: "sheet" },
  { id: "vendor-register-v1", name: "Vendor Register", description: "Vendor management with contracts and risk ratings", type: "base" },
  { id: "risk-register-v1", name: "Risk Register", description: "Risk management with likelihood, impact, and mitigations", type: "base" },
  { id: "decision-log-v1", name: "Decision Log", description: "Decision tracking with context, options, and outcomes", type: "base" },
];

/**
 * Industry-agnostic "Featured" set surfaced by default (Part 2c).
 * These are the general-purpose templates that apply across every
 * industry — the same curated ids backing the built-in fallback
 * gallery. New users see only these ~14; a toggle reveals the full
 * (170+) library for power users. Ids absent from the live registry
 * simply don't render, so the set is safe to keep static.
 */
const FEATURED_TEMPLATE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_TEMPLATES.map((t) => t.id),
);

const TYPE_LABELS: Record<string, string> = {
  document: "Documents",
  slides: "Slides",
  sheet: "Sheets",
  base: "Bases",
};

/**
 * follow-up: Lucide icon set replaces the emoji
 * sprinkle. Components are 14px-aligned so they render the same on
 * every desktop OS (emoji had three different glyphs across Linux /
 * macOS / Windows for the same code point).
 */
const TYPE_ICONS: Record<string, typeof FileText> = {
  document: FileText,
  slides: Presentation,
  sheet: TableIcon,
  base: Database,
};

/**
 * keyboard-navigable template gallery.
 *
 * The gallery is rendered as a single ARIA `listbox` (across all
 * category sections) with arrow-key navigation, Enter to select, and
 * the `aria-activedescendant` pattern instead of roving tabindex.
 * The container holds focus and announces the active option to AT
 * by id; this keeps Tab from cycling through every card and gives
 * screen-reader users a single focus stop for the entire grid.
 *
 * Column count is computed dynamically from the rendered DOM: the
 * grid uses `repeat(auto-fill, minmax(260px, 1fr))` so the column
 * count varies with the viewport. We measure the first row's items
 * via `getBoundingClientRect()` on a ResizeObserver tick. Up/Down
 * arrows then move by `cols`, Left/Right by 1.
 *
 * Categories still render as visually grouped sections, but the
 * underlying keyboard order is the flat visible list so screen
 * readers and arrow keys see a single coherent gallery. The
 * `flatItems` memo is the source of truth for both rendering and
 * navigation arithmetic.
 */
const LISTBOX_ID = "template-gallery-listbox";
const optionDomId = (templateId: string) =>
  `template-option-${templateId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

export default function TemplatesPage() {
  const navigate = useNavigate();
  const { templates, loading } = useTemplateList();
  const [searchQuery, setSearchQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [columns, setColumns] = useState(1);
  // Featured-only is the default first-contact view (Part 2c): show a
  // small, industry-agnostic curated set and hide the long tail behind
  // a "Show all" toggle.
  const [featuredOnly, setFeaturedOnly] = useState(true);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const displayTemplates: TemplateCardData[] = useMemo(() => {
    if (templates.length > 0) {
      return templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        type: t.artifactType,
      }));
    }
    return BUILTIN_TEMPLATES;
  }, [templates]);

  // The Featured set is the curated subset; toggling off reveals the
  // full library. Search always operates on whichever base is active.
  const featuredTemplates = useMemo(
    () => displayTemplates.filter((t) => FEATURED_TEMPLATE_IDS.has(t.id)),
    [displayTemplates],
  );
  // When the curated set matches nothing in the live registry (an
  // unexpected id drift), fall back to the full list so the page is
  // never blank in Featured mode.
  const baseTemplates =
    featuredOnly && featuredTemplates.length > 0
      ? featuredTemplates
      : displayTemplates;

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return baseTemplates;
    const q = searchQuery.toLowerCase();
    return baseTemplates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.type.toLowerCase().includes(q),
    );
  }, [baseTemplates, searchQuery]);

  /**
   * Flatten the visible templates in their rendered order (group by
   * category, preserve in-group order). This is the canonical list
   * for both keyboard navigation and `aria-activedescendant` id
   * lookup.
   */
  const grouped = useMemo(() => {
    const groups: Record<string, TemplateCardData[]> = {};
    for (const tmpl of filtered) {
      const key = TYPE_LABELS[tmpl.type] || tmpl.type;
      if (!groups[key]) groups[key] = [];
      groups[key].push(tmpl);
    }
    return groups;
  }, [filtered]);

  // Devin Review PR #70: compute the flat array AND
  // a `template -> flat index` Map in the same memo. The render
  // path previously used `flatItems.indexOf(tmpl)` per card,
  // which is O(n) per call and O(n²) over the whole gallery. At
  // 14 built-in templates today that's negligible, but the path
  // is on every render of the page and the count is expected to
  // grow (user-authored templates, a marketplace). Building the
  // Map alongside `flatItems` keeps the lookup O(1) without an
  // extra memo dependency — both derive from `grouped` so they
  // recompute together. `flatIndex.get(tmpl)` is a reference
  // lookup (the Map keys are the same `TemplateCardData` objects
  // that the JSX iterates) so it's safe against duplicate IDs.
  const { flatItems, flatIndex } = useMemo(() => {
    const items = Object.values(grouped).flat();
    const idx = new Map<TemplateCardData, number>();
    for (let i = 0; i < items.length; i += 1) {
      idx.set(items[i], i);
    }
    return { flatItems: items, flatIndex: idx };
  }, [grouped]);

  // Re-anchor the active index whenever the visible list shrinks or
  // the user types into the search box — without this, an
  // activeIndex of 5 against a 2-item filter would silently address
  // nothing.
  useEffect(() => {
    if (flatItems.length === 0) {
      setActiveIndex(0);
    } else if (activeIndex >= flatItems.length) {
      setActiveIndex(flatItems.length - 1);
    }
  }, [flatItems, activeIndex]);

  /**
   * Measure the rendered grid's column count by walking the first
   * row of cards and counting how many share the same `offsetTop`.
   * Recomputed on layout via ResizeObserver so a window resize
   * adjusts Up/Down arrow arithmetic without a full re-render.
   * Falls back to 1 column when nothing is rendered yet (which is
   * the correct degenerate value — arrow Down then visits the next
   * item, identical to Right).
   */
  const measureColumns = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) {
      setColumns(1);
      return;
    }
    const cells = Array.from(
      grid.querySelectorAll<HTMLElement>("[data-template-option]"),
    );
    if (cells.length === 0) {
      setColumns(1);
      return;
    }
    const firstTop = cells[0].offsetTop;
    let count = 0;
    for (const c of cells) {
      if (c.offsetTop === firstTop) count += 1;
      else break;
    }
    setColumns(Math.max(1, count));
  }, []);

  useLayoutEffect(() => {
    measureColumns();
  }, [flatItems, measureColumns]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const grid = gridRef.current;
    if (!grid) return;
    const obs = new ResizeObserver(() => measureColumns());
    obs.observe(grid);
    return () => obs.disconnect();
  }, [measureColumns]);

  /**
   * Keyboard handler on the listbox container. Tab is NOT
   * intercepted — it falls through to the browser so focus can
   * leave the gallery. The handler implements:
   *   - ArrowRight / ArrowLeft → +/- 1, no wrap (avoid surprising
   *     jumps to far rows). Clamps at the ends.
   *   - ArrowDown / ArrowUp → +/- columns, clamped at the ends.
   *   - Home → first item; End → last item.
   *   - Enter / Space → activate the selected template.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (flatItems.length === 0) return;
      let next = activeIndex;
      switch (e.key) {
        case "ArrowRight":
          next = Math.min(flatItems.length - 1, activeIndex + 1);
          break;
        case "ArrowLeft":
          next = Math.max(0, activeIndex - 1);
          break;
        case "ArrowDown":
          next = Math.min(flatItems.length - 1, activeIndex + columns);
          break;
        case "ArrowUp":
          next = Math.max(0, activeIndex - columns);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = flatItems.length - 1;
          break;
        case "Enter":
        case " ": {
          e.preventDefault();
          const tmpl = flatItems[activeIndex];
          if (tmpl) navigate(`/create?template=${tmpl.id}`);
          return;
        }
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (next !== activeIndex) setActiveIndex(next);
      // Scroll the newly active card into view for sighted users.
      const targetId = flatItems[next] ? optionDomId(flatItems[next].id) : null;
      if (targetId) {
        const el = document.getElementById(targetId);
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
    },
    [activeIndex, columns, flatItems, navigate],
  );

  if (loading) {
    return (
      <div>
        <PageHeader
          title="Templates"
          description="Choose a template to create a new artifact"
        />
        <p>Loading...</p>
      </div>
    );
  }

  const hasTemplates = displayTemplates.length > 0;
  const activeTemplate = flatItems[activeIndex];
  const activeDescendantId = activeTemplate
    ? optionDomId(activeTemplate.id)
    : undefined;

  return (
    <div>
      <PageHeader
        title="Templates"
        description="Choose a template to create a new artifact"
      />

      {hasTemplates && (
        <div
          style={{
            marginBottom: "var(--spacing-lg)",
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-md)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: "1 1 240px", minWidth: "200px" }}>
            <SearchInput
              placeholder="Search templates..."
              value={searchQuery}
              onSearch={setSearchQuery}
            />
          </div>
          {featuredTemplates.length > 0 &&
            displayTemplates.length > featuredTemplates.length && (
              <button
                type="button"
                className="templates-featured-toggle"
                aria-pressed={!featuredOnly}
                data-testid="templates-featured-toggle"
                onClick={() => setFeaturedOnly((v) => !v)}
                style={{
                  background: "none",
                  border: "1px solid var(--color-border, #d9d9d9)",
                  borderRadius: "var(--radius-md, 6px)",
                  padding: "var(--spacing-sm) var(--spacing-md)",
                  cursor: "pointer",
                  color: "var(--color-text-secondary)",
                  whiteSpace: "nowrap",
                }}
              >
                {featuredOnly
                  ? `Show all ${displayTemplates.length} templates`
                  : "Show featured only"}
              </button>
            )}
        </div>
      )}

      {!hasTemplates ? (
        <EmptyState
          icon={<LayoutTemplate size={48} strokeWidth={1.5} aria-hidden="true" />}
          title="No templates available"
          message="Template files could not be loaded. Check your templates directory."
        />
      ) : Object.keys(grouped).length === 0 ? (
        <EmptyState
          icon={<SearchX size={48} strokeWidth={1.5} aria-hidden="true" />}
          title="No matching templates"
          message={`No templates match "${searchQuery}". Try a different search.`}
        />
      ) : (
        <div
          ref={gridRef}
          role="listbox"
          id={LISTBOX_ID}
          aria-label="Template gallery"
          aria-activedescendant={activeDescendantId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          data-testid="template-gallery"
          style={{ outline: "none" }}
        >
          {Object.entries(grouped).map(([category, items]) => {
            // A `role="listbox"` may only own `option` (and `group`)
            // children — a bare `<section>`/`<h2>` directly inside the
            // listbox trips `aria-required-children`. Each category is
            // therefore a `role="group"` named by its visible heading
            // via `aria-labelledby`, which is the WAI-ARIA grouped-
            // listbox pattern and keeps the category labels exposed to
            // assistive tech without polluting the option set.
            const groupLabelId = `${LISTBOX_ID}-group-${category.replace(
              /[^a-zA-Z0-9_-]/g,
              "_",
            )}`;
            return (
              <div
                key={category}
                role="group"
                aria-labelledby={groupLabelId}
                style={{ marginBottom: "var(--spacing-xl)" }}
              >
                {/*
                  The category label is the visible name of the `group`,
                  conveyed to assistive tech via the group's
                  `aria-labelledby`. A real heading is not a permitted
                  child of a `listbox`/`group` (it is neither `option`
                  nor `group`), so this carries `role="presentation"`:
                  it stays visually a styled section title and still
                  supplies the group's accessible name through
                  `aria-labelledby`, but is removed from the heading
                  outline and the listbox's owned-element set
                  (`aria-required-children`).
                */}
                <h2
                  id={groupLabelId}
                  role="presentation"
                  className="section-title"
                  style={{ marginBottom: "var(--spacing-md)" }}
                >
                  {category}
                </h2>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: "var(--spacing-md)",
                  }}
                >
                  {items.map((tmpl) => {
                    // Flat index across all sections — drives the
                    // active-descendant arithmetic and Enter activation.
                    // O(1) Map lookup; see the `flatIndex` doc-comment
                    // on the memo above for the rationale.
                    const flatIdx = flatIndex.get(tmpl) ?? -1;
                    const isActive = flatIdx === activeIndex;
                    const Icon = TYPE_ICONS[tmpl.type] ?? FileText;
                    // Activation (mouse) lives on the `option` itself, not
                    // on an inner button. Putting `onClick` on a `Card`
                    // gave it `role="button"` + `tabIndex=0`, i.e. a
                    // focusable control nested inside the `option` —
                    // `nested-interactive`. In the active-descendant
                    // listbox the single tab stop is the listbox; options
                    // are never individually focusable, so the inner Card
                    // must stay non-interactive.
                    const activate = () => {
                      setActiveIndex(flatIdx);
                      navigate(`/create?template=${tmpl.id}`);
                    };
                    return (
                      <div
                        key={tmpl.id}
                        id={optionDomId(tmpl.id)}
                        role="option"
                        aria-selected={isActive}
                        data-template-option
                        data-template-id={tmpl.id}
                        data-template-index={flatIdx}
                        onClick={activate}
                        style={{ cursor: "pointer" }}
                      >
                        <Card
                          className={isActive ? "card-active" : undefined}
                          style={
                            isActive
                              ? {
                                  outline:
                                    "2px solid var(--color-primary, #4f46e5)",
                                  outlineOffset: "2px",
                                }
                              : undefined
                          }
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "var(--spacing-sm)",
                              marginBottom: "var(--spacing-sm)",
                            }}
                          >
                            <Icon
                              size={16}
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            <span
                              className="card-title"
                              style={{ margin: 0 }}
                            >
                              {tmpl.name}
                            </span>
                          </div>
                          <div className="card-description">
                            {tmpl.description}
                          </div>
                        </Card>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
