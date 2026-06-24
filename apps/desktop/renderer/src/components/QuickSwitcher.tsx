/**
 * Global fuzzy quick switcher — Obsidian's Ctrl/Cmd+O.
 *
 * A dedicated overlay, distinct from the Cmd+K command palette, that
 * fuzzy-finds and jumps to ANY navigable entity: sources, artifacts,
 * templates, automations, tasks, and the app's own pages. One flat,
 * ranked list (Obsidian-style — type/path subtitle per row, no
 * category headers) so keyboard navigation is linear and the list can
 * virtualise with a uniform row height.
 *
 * Data is read live from `window.tessera.*` via
 * {@link useQuickSwitcherItems}; ranking (fuzzy + recency) lives in the
 * pure {@link rankQuickSwitchItems}. Recently-viewed artifacts float to
 * the top on an empty query and get a boost on a matching one.
 *
 * Accessibility: the input is an ARIA combobox driving a listbox via
 * `aria-activedescendant`; the active row is never DOM-focused so all
 * typing stays in the query field (WAI-ARIA combobox pattern). Focus
 * is trapped within the panel, restored to the prior element on close,
 * and the whole widget is operable keyboard-only.
 *
 * Performance: the query feeding the ranker is deferred
 * (`useDeferredValue`) so typing stays responsive on large libraries,
 * results are hard-capped, and the list virtualises past a threshold.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { useCspNonce } from "../utils/cspNonce";
import { useQuickSwitcherItems } from "../hooks/useQuickSwitcherItems";
import { useRecentlyViewedArtifacts } from "../hooks/useRecentlyViewedArtifacts";
import { useVirtualRows } from "../hooks/useVirtualRows";
import { useWorkspace } from "../workspace/workspaceContext";
import { openModeFromEvent, type OpenMode } from "../workspace/useOpenTarget";
import {
  kindLabel,
  rankQuickSwitchItems,
  type RankedQuickSwitchItem,
} from "../utils/quickSwitch";

interface QuickSwitcherProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Hard cap on ranked rows; protects very large libraries. */
const MAX_RESULTS = 50;
/** Uniform row height (px) the virtualiser windows against. Mirrors
 *  the `.qs-row` height in the stylesheet below. */
const ROW_HEIGHT = 52;
/** Virtualise only once the list is long enough to matter. */
const VIRTUALIZE_THRESHOLD = 30;
/** Rows kept beyond the viewport on each side while virtualising. */
const OVERSCAN = 6;

// Selector covering the focusable controls inside the panel, used to
// trap Tab focus (WAI-ARIA dialog pattern).
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Render a title with the fuzzy-matched character indices emphasised. */
function HighlightedTitle({
  title,
  matchedIndices,
}: {
  title: string;
  matchedIndices: number[];
}) {
  if (matchedIndices.length === 0) return <>{title}</>;
  const set = new Set(matchedIndices);
  const out: React.ReactNode[] = [];
  let run = "";
  let runIsMatch = set.has(0);
  for (let i = 0; i < title.length; i++) {
    const isMatch = set.has(i);
    if (isMatch !== runIsMatch && run.length > 0) {
      out.push(
        runIsMatch ? (
          <mark key={i - run.length} className="qs-mark">
            {run}
          </mark>
        ) : (
          <span key={i - run.length}>{run}</span>
        ),
      );
      run = "";
    }
    runIsMatch = isMatch;
    run += title[i];
  }
  if (run.length > 0) {
    out.push(
      runIsMatch ? (
        <mark key={title.length - run.length} className="qs-mark">
          {run}
        </mark>
      ) : (
        <span key={title.length - run.length}>{run}</span>
      ),
    );
  }
  return <>{out}</>;
}

export default function QuickSwitcher({ isOpen, onClose }: QuickSwitcherProps) {
  const cspNonce = useCspNonce();
  const navigate = useNavigate();
  const { openTab, openInSplit } = useWorkspace();
  const { items, loading, error, hasBridge, refreshAll } =
    useQuickSwitcherItems();
  const { recentIds } = useRecentlyViewedArtifacts();

  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const hasFetchedOnOpenRef = useRef(false);

  const listboxId = useId();
  const optionIdPrefix = useId();

  const recentKeys = useMemo(() => [...recentIds], [recentIds]);
  const modKeyLabel = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      /Mac|iPhone|iPad/.test(navigator.platform)
        ? "⌘"
        : "Ctrl",
    [],
  );

  const ranked = useMemo<RankedQuickSwitchItem[]>(
    () =>
      rankQuickSwitchItems({
        items,
        query: deferredQuery,
        recentKeys,
        limit: MAX_RESULTS,
      }),
    [items, deferredQuery, recentKeys],
  );

  // Reset + focus + refresh on every open; restore focus on close.
  useEffect(() => {
    if (!isOpen) return;
    previousActiveRef.current = document.activeElement as HTMLElement | null;
    setQuery("");
    setActiveIndex(0);
    // The underlying list hooks fetch once on mount, which — since this
    // component mounts lazily on the first open — already covers that
    // first open. Skip the redundant refreshAll() that first time to
    // avoid a double IPC round-trip per list; refresh on every
    // subsequent open so reopening still shows a fresh library.
    if (hasFetchedOnOpenRef.current) {
      refreshAll();
    } else {
      hasFetchedOnOpenRef.current = true;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      const prev = previousActiveRef.current;
      if (prev && typeof prev.focus === "function") prev.focus();
    };
    // `refreshAll` is stable (useCallback); intentionally not re-run on
    // its identity so reopening, not every render, triggers a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Clamp the active row when the result set shrinks.
  useEffect(() => {
    if (activeIndex >= ranked.length) {
      setActiveIndex(Math.max(0, ranked.length - 1));
    }
  }, [activeIndex, ranked.length]);

  const virtualize = ranked.length > VIRTUALIZE_THRESHOLD;
  const { startIndex, endIndex, topPad, bottomPad, onScroll } = useVirtualRows(
    listRef,
    {
      rowCount: ranked.length,
      rowHeight: ROW_HEIGHT,
      enabled: virtualize,
      overscan: OVERSCAN,
    },
  );

  // Keep the active row visible. Uniform row height lets us drive the
  // scroll position directly; setting `scrollTop` fires the scroll
  // event the virtualiser listens to, so the window re-computes.
  useEffect(() => {
    if (!isOpen) return;
    const el = listRef.current;
    if (!el || ranked.length === 0) return;
    const rowTop = activeIndex * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < el.scrollTop) {
      el.scrollTop = rowTop;
    } else if (rowBottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = rowBottom - el.clientHeight;
    }
  }, [activeIndex, isOpen, ranked.length]);

  const handleSelect = useCallback(
    (index: number, mode: OpenMode = "current") => {
      const row = ranked[index];
      if (!row) return;
      onClose();
      // Modifier-aware open: a plain pick replaces the focused view
      // (shell navigation), while Ctrl/Cmd (+Shift) routes the same
      // destination into a new tab / split via the workspace API.
      if (mode === "new-split") {
        openInSplit(row.item.to);
      } else if (mode === "new-tab") {
        openTab(row.item.to);
      } else {
        navigate(row.item.to);
      }
    },
    [ranked, navigate, onClose, openTab, openInSplit],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          onClose();
          return;
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) =>
            Math.max(0, Math.min(ranked.length - 1, i + 1)),
          );
          return;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(0, i - 1));
          return;
        case "Home":
          e.preventDefault();
          setActiveIndex(0);
          return;
        case "End":
          e.preventDefault();
          setActiveIndex(Math.max(0, ranked.length - 1));
          return;
        case "Enter": {
          e.preventDefault();
          const mod = e.metaKey || e.ctrlKey;
          const mode: OpenMode = mod
            ? e.shiftKey
              ? "new-split"
              : "new-tab"
            : "current";
          handleSelect(activeIndex, mode);
          return;
        }
        default:
          return;
      }
    },
    [ranked.length, activeIndex, handleSelect, onClose],
  );

  // Trap Tab focus within the panel (the input is the only natural
  // tab stop, so Tab/Shift+Tab just keep focus on it).
  const handlePanelKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== "Tab" || !panelRef.current) return;
    const focusables =
      panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (!isOpen) return null;

  const activeOptionId =
    ranked.length > 0 ? `${optionIdPrefix}-${activeIndex}` : undefined;

  // No-bridge and partial-load errors are surfaced as a banner above
  // the list (see `qs-notice` below) rather than here: the page rows
  // derived from SIDEBAR_ITEMS are always present, so the list is never
  // empty in those states and an in-list message would never show.
  const renderStatus = (): React.ReactNode => {
    if (loading && items.length === 0) {
      return (
        <li className="qs-empty" role="option" aria-disabled="true">
          Loading your library&hellip;
        </li>
      );
    }
    if (items.length === 0) {
      return (
        <li className="qs-empty" role="option" aria-disabled="true">
          Nothing to switch to yet — add a source or create an artifact.
        </li>
      );
    }
    return (
      <li className="qs-empty" role="option" aria-disabled="true">
        No matches{query.trim() ? ` for “${query.trim()}”` : ""}.
      </li>
    );
  };

  const visible = virtualize ? ranked.slice(startIndex, endIndex + 1) : ranked;

  return (
    <div
      className="qs-overlay"
      role="presentation"
      onClick={onClose}
      data-testid="quick-switcher-overlay"
    >
      <div
        className="qs-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handlePanelKeyDown}
      >
        <input
          ref={inputRef}
          className="qs-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Go to anything — sources, artifacts, templates, pages…"
          aria-label="Quick switch query"
          autoComplete="off"
          spellCheck={false}
          data-testid="quick-switcher-input"
        />
        {!hasBridge ? (
          <div
            className="qs-notice"
            role="status"
            data-testid="quick-switcher-notice"
          >
            Quick switch is running outside the desktop app — only pages are
            available.
          </div>
        ) : error ? (
          <div
            className="qs-notice qs-notice-error"
            role="status"
            data-testid="quick-switcher-notice"
          >
            Couldn&rsquo;t load part of your library: {error}
          </div>
        ) : null}
        <div
          ref={listRef}
          className="qs-list-scroll"
          onScroll={onScroll}
          data-testid="quick-switcher-scroll"
          // The results can overflow and scroll; make the region keyboard
          // focusable so keyboard-only users can scroll it directly (the
          // combobox arrow-key navigation already scrolls the active option
          // into view, but the region must be reachable on its own too).
          // role=group + aria-label give the focusable region a meaningful
          // name so it announces as "Search results" rather than an unnamed
          // group; the inner <ul role=listbox> still carries the options.
          tabIndex={0}
          role="group"
          aria-label="Search results"
        >
          <ul className="qs-list" role="listbox" id={listboxId}>
            {ranked.length === 0 && renderStatus()}
            {ranked.length > 0 && virtualize && topPad > 0 && (
              <li
                className="qs-spacer"
                aria-hidden="true"
                style={{ height: topPad }}
              />
            )}
            {visible.map((row, i) => {
              const idx = (virtualize ? startIndex : 0) + i;
              const active = idx === activeIndex;
              return (
                <li
                  key={row.item.id}
                  id={`${optionIdPrefix}-${idx}`}
                  role="option"
                  aria-selected={active}
                  data-row-index={idx}
                  className={`qs-row ${active ? "qs-row-active" : ""}`}
                  onMouseMove={() => {
                    if (!active) setActiveIndex(idx);
                  }}
                  onClick={(e) => handleSelect(idx, openModeFromEvent(e))}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    handleSelect(idx, "new-split");
                  }}
                >
                  <span className={`qs-badge qs-badge-${row.item.kind}`}>
                    {kindLabel(row.item.kind)}
                  </span>
                  <span className="qs-row-main">
                    <span className="qs-row-title">
                      <HighlightedTitle
                        title={row.item.title}
                        matchedIndices={row.matchedIndices}
                      />
                    </span>
                    <span className="qs-row-sub">{row.item.subtitle}</span>
                  </span>
                </li>
              );
            })}
            {ranked.length > 0 && virtualize && bottomPad > 0 && (
              <li
                className="qs-spacer"
                aria-hidden="true"
                style={{ height: bottomPad }}
              />
            )}
          </ul>
        </div>
        <div className="qs-footer">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>navigate</span>
          <kbd>↵</kbd>
          <span>open</span>
          <kbd>{modKeyLabel}</kbd>
          <kbd>↵</kbd>
          <span>new tab</span>
          <kbd>{modKeyLabel}</kbd>
          <kbd>⇧</kbd>
          <kbd>↵</kbd>
          <span>split</span>
          <kbd>esc</kbd>
          <span>close</span>
        </div>
      </div>
      <style nonce={cspNonce}>{`
        .qs-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          z-index: 1000;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding-top: 80px;
        }
        .qs-panel {
          background: var(--color-bg-elevated);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          width: min(640px, 92vw);
          max-height: 70vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
        }
        .qs-input {
          font-size: var(--font-size-md);
          padding: var(--spacing-md) var(--spacing-lg);
          border: none;
          background: transparent;
          color: var(--color-text-body);
          border-bottom: 1px solid var(--color-border);
          outline: none;
        }
        .qs-list-scroll {
          overflow-y: auto;
          flex: 1;
        }
        .qs-list {
          list-style: none;
          padding: var(--spacing-xs) 0;
          margin: 0;
        }
        .qs-empty {
          padding: var(--spacing-md) var(--spacing-lg);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          list-style: none;
        }
        .qs-error {
          color: var(--color-danger, var(--color-text-secondary));
        }
        .qs-notice {
          padding: var(--spacing-sm) var(--spacing-lg);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          border-bottom: 1px solid var(--color-border);
        }
        .qs-notice-error {
          color: var(--color-danger, var(--color-text-secondary));
        }
        .qs-spacer {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .qs-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          height: ${ROW_HEIGHT}px;
          box-sizing: border-box;
          padding: 0 var(--spacing-lg);
          cursor: pointer;
          font-size: var(--font-size-sm);
        }
        .qs-row-active {
          background: var(--color-primary-light);
        }
        .qs-badge {
          flex-shrink: 0;
          font-size: var(--font-size-xs);
          text-transform: uppercase;
          letter-spacing: 0.04em;
          padding: 2px 6px;
          border-radius: 4px;
          background: var(--color-bg-secondary, transparent);
          color: var(--color-text-secondary);
          min-width: 72px;
          text-align: center;
        }
        .qs-badge-artifact {
          background: var(--color-primary-light);
          color: var(--color-primary);
        }
        .qs-row-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }
        .qs-row-title {
          color: var(--color-text-body);
          font-weight: var(--font-weight-medium);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .qs-mark {
          background: transparent;
          color: var(--color-primary);
          font-weight: var(--font-weight-bold, 700);
        }
        .qs-row-sub {
          color: var(--color-text-secondary);
          font-size: var(--font-size-xs);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .qs-footer {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-sm) var(--spacing-lg);
          border-top: 1px solid var(--color-border);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .qs-footer kbd {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          background: var(--color-bg-secondary, transparent);
          padding: 1px 5px;
          border-radius: 3px;
        }
        .qs-footer span {
          margin-right: var(--spacing-sm);
        }
      `}</style>
    </div>
  );
}
