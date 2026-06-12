/**
 * Cmd+K command palette.
 *
 * Single overlay that fuses four UX patterns into one widget:
 *
 *   1. **Command palette**: every entry in `COMMAND_REGISTRY` is a
 *      row. Selecting a row invokes its navigate / dispatch /
 *      callback action.
 *   2. **Global cross-artifact search**: every artifact is also a
 *      row, and a single fuzzy query string filters both commands
 *      and artifacts. Selecting an artifact opens its editor page.
 *   3. **Favorites / Pinned**: a "Pinned" group renders first when
 *      the query is empty, surfacing the user's pinned artifacts
 *      as one-tap targets.
 *   4. **Recent items navigation**: a "Recent" group below "Pinned"
 *      renders the view-history list from
 *      `useRecentlyViewedArtifacts`.
 *
 * The single-input pattern (one text field for everything) mirrors
 * VSCode / Linear / Raycast and avoids the user having to remember
 * which palette to open for which target.
 *
 * Stale entries (pinned/recent IDs whose artifact has since been
 * deleted) are pruned **lazily** when the palette opens — joining
 * the IDs against the live artifact list happens on every open,
 * and any missing IDs trigger a `prune*` IPC call to keep the
 * persisted lists honest without needing a delete-time hook.
 *
 * Keyboard: ArrowUp/Down to navigate, Enter to activate, Escape to
 * close. The query input owns focus while open so all typing goes
 * to filtering (no need for a mode toggle).
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { useCspNonce } from "../utils/cspNonce";
import { useArtifactList } from "../hooks/useArtifacts";
import { usePinnedArtifacts } from "../hooks/usePinnedArtifacts";
import { useRecentlyViewedArtifacts } from "../hooks/useRecentlyViewedArtifacts";
import { useSettings, useUpdateSetting } from "../hooks/useSettings";
import { fuzzyFilter } from "../utils/fuzzyMatch";
import {
  type Command,
  COMMAND_REGISTRY,
  formatChord,
} from "../utils/commandRegistry";
import type { ArtifactInfo } from "../types/ipc";

const MAX_RESULTS = 50;

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Optional initial mode. "quickSwitcher" hides command rows and
   * only shows recents/pinned/artifacts — used by Cmd+P. "full"
   * (default) shows both commands and artifacts.
   */
  mode?: "full" | "quickSwitcher";
}

type PaletteRow =
  | { kind: "command"; command: Command }
  | { kind: "artifact"; artifact: ArtifactInfo; tag: "pinned" | "recent" | "all" };

interface PaletteGroup {
  label: string;
  rows: PaletteRow[];
}

export default function CommandPalette({
  isOpen,
  onClose,
  mode = "full",
}: CommandPaletteProps) {
  const cspNonce = useCspNonce();
  const navigate = useNavigate();
  const { artifacts, loading: artifactsLoading } = useArtifactList();
  const { pinnedIds, prunePinned } = usePinnedArtifacts();
  const { recentIds, pruneRecents } = useRecentlyViewedArtifacts();
  const { settings } = useSettings();
  const { update: updateSetting } = useUpdateSetting();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);

  const artifactById = useMemo(() => {
    const map = new Map<string, ArtifactInfo>();
    for (const a of artifacts) map.set(a.id, a);
    return map;
  }, [artifacts]);

  // Prune stale pinned/recent IDs lazily when the palette opens
  // AND the artifact list has finished loading. Without this, a
  // user who deletes a pinned artifact elsewhere would see a
  // "ghost" row in the palette until they manually unpinned it.
  //
  // Gate on `!artifactsLoading` (not `artifacts.length > 0`)
  // because if every artifact has been deleted the list is
  // legitimately empty and EVERY pinned/recent id is stale — we
  // still want to prune in that case. Earlier code guarded on
  // `artifacts.length === 0` and silently skipped the prune,
  // leaving the user with a palette full of dead ids. PR #87
  useEffect(() => {
    if (!isOpen || artifactsLoading) return;
    const stalePins = new Set<string>();
    for (const id of pinnedIds) {
      if (!artifactById.has(id)) stalePins.add(id);
    }
    if (stalePins.size > 0) void prunePinned(stalePins);
    const staleRecents = new Set<string>();
    for (const id of recentIds) {
      if (!artifactById.has(id)) staleRecents.add(id);
    }
    if (staleRecents.size > 0) void pruneRecents(staleRecents);
  }, [
    isOpen,
    artifactsLoading,
    artifactById,
    pinnedIds,
    recentIds,
    prunePinned,
    pruneRecents,
  ]);

  // Reset state on every open so the user always starts at row 0
  // with an empty query, regardless of where they left off last
  // time.
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setActiveIndex(0);
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [isOpen]);

  const visibleCommands = useMemo(() => {
    if (mode === "quickSwitcher") return [];
    return COMMAND_REGISTRY.filter((c) => !c.hiddenFromPalette);
  }, [mode]);

  const pinnedArtifacts = useMemo(() => {
    return pinnedIds
      .map((id) => artifactById.get(id))
      .filter((a): a is ArtifactInfo => a !== undefined);
  }, [pinnedIds, artifactById]);

  const recentArtifacts = useMemo(() => {
    return recentIds
      .map((id) => artifactById.get(id))
      .filter((a): a is ArtifactInfo => a !== undefined);
  }, [recentIds, artifactById]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const q = query.trim();
    if (q.length === 0) {
      const groups: PaletteGroup[] = [];
      if (pinnedArtifacts.length > 0) {
        groups.push({
          label: "Pinned",
          rows: pinnedArtifacts.map((a) => ({
            kind: "artifact" as const,
            artifact: a,
            tag: "pinned" as const,
          })),
        });
      }
      if (recentArtifacts.length > 0) {
        const pinnedSet = new Set(pinnedIds);
        const recentsWithoutPinned = recentArtifacts.filter(
          (a) => !pinnedSet.has(a.id),
        );
        if (recentsWithoutPinned.length > 0) {
          groups.push({
            label: "Recent",
            rows: recentsWithoutPinned.map((a) => ({
              kind: "artifact" as const,
              artifact: a,
              tag: "recent" as const,
            })),
          });
        }
      }
      if (mode !== "quickSwitcher") {
        groups.push({
          label: "Commands",
          rows: visibleCommands.map((c) => ({
            kind: "command" as const,
            command: c,
          })),
        });
      }
      if (mode === "quickSwitcher" && artifacts.length > 0) {
        const pinnedSet = new Set(pinnedIds);
        const recentSet = new Set(recentIds);
        const others = artifacts.filter(
          (a) => !pinnedSet.has(a.id) && !recentSet.has(a.id),
        );
        if (others.length > 0) {
          groups.push({
            label: "Artifacts",
            rows: others.slice(0, MAX_RESULTS).map((a) => ({
              kind: "artifact" as const,
              artifact: a,
              tag: "all" as const,
            })),
          });
        }
      }
      return groups;
    }

    // Search mode: fuzzy-filter across commands + artifacts and
    // merge into a single ranked list, then re-group by source.
    const commandMatches = fuzzyFilter(
      visibleCommands,
      q,
      (c) => `${c.title} ${(c.keywords ?? []).join(" ")}`,
    );
    const artifactMatches = fuzzyFilter(
      artifacts,
      q,
      (a) => `${a.title} ${a.artifactType}`,
      MAX_RESULTS,
    );

    const commandRows: PaletteRow[] = commandMatches.map((m) => ({
      kind: "command",
      command: m.item,
    }));
    // Hoist the pinned/recent Sets above the .map so we don't pay
    // O(N) construction cost per row. pinnedIds is capped at 256,
    // recentIds at MAX_RECENT_ARTIFACTS=32, so the Sets cost
    // <O(300) once instead of <O(300 * MAX_RESULTS) inside the loop.
    const pinnedSet = new Set(pinnedIds);
    const recentSet = new Set(recentIds);
    const artifactRows: PaletteRow[] = artifactMatches.map((m) => {
      const tag = pinnedSet.has(m.item.id)
        ? "pinned"
        : recentSet.has(m.item.id)
          ? "recent"
          : "all";
      return { kind: "artifact", artifact: m.item, tag };
    });

    const groups: PaletteGroup[] = [];
    if (commandRows.length > 0)
      groups.push({ label: "Commands", rows: commandRows });
    if (artifactRows.length > 0)
      groups.push({ label: "Artifacts", rows: artifactRows });
    return groups;
  }, [
    query,
    visibleCommands,
    artifacts,
    pinnedArtifacts,
    recentArtifacts,
    pinnedIds,
    recentIds,
    mode,
  ]);

  // Flatten for keyboard navigation. Each entry knows the row plus
  // its absolute index so the active row maps back to a single
  // selection.
  const flatRows = useMemo(() => {
    const flat: PaletteRow[] = [];
    for (const g of groups) flat.push(...g.rows);
    return flat;
  }, [groups]);

  // Precomputed start index per group so the render body can
  // derive each row's absolute palette index from
  // `groupStartIndexes[gi] + ri` instead of relying on a
  // mutating-during-render `let rowCursor = 0; rowCursor++`
  // counter. PR #87: the prior
  // pattern was technically safe (React 18 strict mode double-
  // invocation produced the same values both passes) but mutating
  // a render-local outside the JSX tree is unconventional and
  // hard to reason about. This `useMemo` keeps the derivation
  // explicit and stable.
  const groupStartIndexes = useMemo(() => {
    const starts: number[] = [];
    let cursor = 0;
    for (const g of groups) {
      starts.push(cursor);
      cursor += g.rows.length;
    }
    return starts;
  }, [groups]);

  // Clamp active index whenever the visible list shrinks.
  useEffect(() => {
    if (activeIndex >= flatRows.length) {
      setActiveIndex(Math.max(0, flatRows.length - 1));
    }
  }, [activeIndex, flatRows.length]);

  const handleSelect = useCallback(
    (row: PaletteRow) => {
      onClose();
      if (row.kind === "artifact") {
        navigate(`/artifacts/${row.artifact.id}/edit`);
        return;
      }
      const cmd = row.command;
      if (cmd.kind === "navigate") {
        navigate(cmd.to);
        return;
      }
      if (cmd.kind === "dispatch") {
        window.dispatchEvent(
          new CustomEvent(
            cmd.event,
            cmd.detail ? { detail: cmd.detail } : undefined,
          ),
        );
        return;
      }
      if (cmd.kind === "callback") {
        // Renderer-side callbacks the palette knows how to execute
        // inline — these are the meta-actions that don't make
        // sense to route through CustomEvent because no other
        // listener could plausibly own them.
        switch (cmd.callbackId) {
          case "openCommandPalette":
            // Already open — no-op.
            return;
          case "openQuickSwitcher":
            // Hand off to the dedicated cross-entity quick switcher.
            // The palette is already closing (onClose above); fire the
            // open event so they don't stack on screen.
            window.dispatchEvent(new CustomEvent("tessera:open-quick-switch"));
            return;
          case "openShortcutsHelp":
            window.dispatchEvent(new CustomEvent("tessera:open-shortcuts"));
            return;
          case "toggleSidebar":
            window.dispatchEvent(new CustomEvent("tessera:toggle-sidebar"));
            return;
          case "toggleTheme": {
            // Three-state cycle: system -> dark -> light -> system.
            // See `useKeyboardShortcuts.toggleTheme` for the rationale;
            // we keep the two runners in lockstep so the chord and the
            // palette behave identically.
            const next =
              settings.theme === "system"
                ? "dark"
                : settings.theme === "dark"
                  ? "light"
                  : "system";
            void updateSetting({ theme: next });
            return;
          }
          case "goBack":
            // react-router back navigation, matching the keyboard
            // runner. `navigate(-1)` not
            // `window.history.back()` so the router's own history
            // stack stays in phase with the location bar.
            navigate(-1);
            return;
          default:
            return;
        }
      }
    },
    [navigate, onClose, settings.theme, updateSetting],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        // `Math.max(0, ...)` guards the empty-rows case: when
        // `flatRows.length === 0` (no matches state), naively
        // computing `Math.min(-1, i + 1)` would set `activeIndex`
        // to -1 and the clamp at the top of `flatRows` derivation
        // only fires when the index is over the upper bound, not
        // below 0. PR #87 round 3.
        setActiveIndex((i) =>
          Math.max(0, Math.min(flatRows.length - 1, i + 1)),
        );
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setActiveIndex(Math.max(0, flatRows.length - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const row = flatRows[activeIndex];
        if (row) handleSelect(row);
      }
    },
    [activeIndex, flatRows, handleSelect, onClose],
  );

  // Scroll the active row into view when activeIndex changes via
  // keyboard. Using `scrollIntoView({ block: 'nearest' })` to
  // avoid jumping the whole panel when the active row is already
  // visible.
  useEffect(() => {
    if (!isOpen) return;
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(
      `[data-row-index="${activeIndex}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="cmdk-overlay"
      role="presentation"
      onClick={onClose}
      data-testid="command-palette-overlay"
    >
      <div
        className="cmdk-panel"
        role="dialog"
        aria-label={mode === "quickSwitcher" ? "Quick switcher" : "Command palette"}
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            mode === "quickSwitcher"
              ? "Jump to an artifact…"
              : "Type a command, search artifacts…"
          }
          aria-label="Command palette query"
          autoComplete="off"
          spellCheck={false}
          data-testid="command-palette-input"
        />
        <ul ref={listRef} className="cmdk-list" role="listbox">
          {groups.length === 0 && (
            <li className="cmdk-empty">No matches</li>
          )}
          {groups.map((group, gi) => (
            <li key={group.label} className="cmdk-group">
              <div className="cmdk-group-label">{group.label}</div>
              <ul className="cmdk-group-rows">
                {group.rows.map((row, ri) => {
                  const idx = groupStartIndexes[gi] + ri;
                  const active = idx === activeIndex;
                  const rowKey =
                    row.kind === "command"
                      ? `cmd-${row.command.id}`
                      : `art-${row.artifact.id}`;
                  return (
                    <li
                      key={rowKey}
                      data-row-index={idx}
                      data-row-active={active ? "true" : "false"}
                      className={`cmdk-row ${active ? "cmdk-row-active" : ""}`}
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => handleSelect(row)}
                    >
                      <div className="cmdk-row-main">
                        <div className="cmdk-row-title">
                          {row.kind === "command"
                            ? row.command.title
                            : row.artifact.title || "(untitled)"}
                        </div>
                        <div className="cmdk-row-sub">
                          {row.kind === "command"
                            ? row.command.description
                            : row.artifact.artifactType}
                        </div>
                      </div>
                      {row.kind === "command" && row.command.chord && (
                        <kbd className="cmdk-kbd">
                          {formatChord(row.command.chord, isMac)}
                        </kbd>
                      )}
                      {row.kind === "artifact" && row.tag === "pinned" && (
                        <span className="cmdk-tag cmdk-tag-pinned">Pinned</span>
                      )}
                      {row.kind === "artifact" && row.tag === "recent" && (
                        <span className="cmdk-tag cmdk-tag-recent">Recent</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
        <div className="cmdk-footer">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>navigate</span>
          <kbd>↵</kbd>
          <span>select</span>
          <kbd>esc</kbd>
          <span>close</span>
        </div>
      </div>
      <style nonce={cspNonce}>{`
        .cmdk-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.4);
          z-index: 1000;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding-top: 80px;
        }
        .cmdk-panel {
          background: var(--color-bg-elevated);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          width: min(640px, 92vw);
          max-height: 70vh;
          display: flex;
          flex-direction: column;
          box-shadow: 0 16px 48px rgba(0, 0, 0, 0.24);
        }
        .cmdk-input {
          font-size: var(--font-size-md);
          padding: var(--spacing-md) var(--spacing-lg);
          border: none;
          background: transparent;
          color: var(--color-text-body);
          border-bottom: 1px solid var(--color-border);
          outline: none;
        }
        .cmdk-list {
          list-style: none;
          padding: var(--spacing-xs) 0;
          margin: 0;
          overflow-y: auto;
          flex: 1;
        }
        .cmdk-empty {
          padding: var(--spacing-md) var(--spacing-lg);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
        }
        .cmdk-group {
          list-style: none;
        }
        .cmdk-group-label {
          padding: var(--spacing-xs) var(--spacing-lg);
          font-size: var(--font-size-xs);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--color-text-secondary);
        }
        .cmdk-group-rows {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .cmdk-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-lg);
          cursor: pointer;
          font-size: var(--font-size-sm);
        }
        .cmdk-row-active {
          background: var(--color-primary-light);
        }
        .cmdk-row-main {
          flex: 1;
          min-width: 0;
        }
        .cmdk-row-title {
          color: var(--color-text-body);
          font-weight: var(--font-weight-medium);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .cmdk-row-sub {
          color: var(--color-text-secondary);
          font-size: var(--font-size-xs);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .cmdk-kbd {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          background: var(--color-bg-secondary, transparent);
          padding: 2px 6px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .cmdk-tag {
          font-size: var(--font-size-xs);
          padding: 2px 6px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .cmdk-tag-pinned {
          background: var(--color-warning-bg, var(--color-bg-secondary));
          color: var(--color-warning, var(--color-text-body));
        }
        .cmdk-tag-recent {
          background: var(--color-primary-light);
          color: var(--color-primary);
        }
        .cmdk-footer {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: var(--spacing-sm) var(--spacing-lg);
          border-top: 1px solid var(--color-border);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .cmdk-footer kbd {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          background: var(--color-bg-secondary, transparent);
          padding: 1px 5px;
          border-radius: 3px;
        }
        .cmdk-footer span {
          margin-right: var(--spacing-sm);
        }
      `}</style>
    </div>
  );
}
