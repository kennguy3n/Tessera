import { useCallback, useMemo, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Star, ChevronDown, ChevronRight } from "lucide-react";
import {
  PRIMARY_SIDEBAR_ITEMS,
  SECONDARY_SIDEBAR_ITEMS,
  SIDEBAR_SHORTCUT_HINTS,
  type SidebarNavItem,
} from "../navigation";
import KchatSidebarSection from "./KchatSidebarSection";
import { useCspNonce } from "../utils/cspNonce";
import { useArtifactList } from "../hooks/useArtifacts";
import { usePinnedArtifacts } from "../hooks/usePinnedArtifacts";
import { useSettings } from "../hooks/useSettings";
import { useOpenTarget } from "../workspace/useOpenTarget";
import type { ArtifactInfo } from "../types/ipc";

/**
 * localStorage key holding the user's explicit expand/collapse choice
 * for the "More tools" secondary section. Stored as the string
 * `"true"` / `"false"`. When absent, the section's default open state
 * is derived from the `simplifiedNav` setting (collapsed when
 * simplified). An explicit choice always wins over the setting so a
 * power user who expands the section keeps it expanded across launches
 * even with simplified navigation on.
 */
const MORE_TOOLS_STORAGE_KEY = "tessera:sidebar-more-tools-expanded";

function readStoredMoreToolsExpanded(): boolean | null {
  try {
    const v =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(MORE_TOOLS_STORAGE_KEY)
        : null;
    if (v === "true") return true;
    if (v === "false") return false;
  } catch {
    // localStorage can throw in locked-down environments; fall back
    // to the setting-derived default.
  }
  return null;
}

interface SidebarProps {
  /**
   * when true, render the sidebar as a
   * narrow icon-only rail. Driven by the `tessera:toggle-sidebar`
   * custom event from the keyboard-shortcut runner; default false.
   */
  collapsed?: boolean;
}

export default function Sidebar({ collapsed = false }: SidebarProps) {
  const cspNonce = useCspNonce();
  const { settings } = useSettings();
  const { pinnedIds } = usePinnedArtifacts();
  // Gate the artifact-list IPC on `pinnedIds.length > 0` so a
  // fresh-install / zero-pins user never pays the cost of fetching
  // every artifact (including `content: string`) just to render an
  // empty Pinned section. PR #87 round
  // 3. When the user pins their first artifact the gate flips
  // open, `useArtifactList` re-runs its mount effect, and the
  // sidebar's Pinned section populates on the next render.
  const { artifacts } = useArtifactList({ enabled: pinnedIds.length > 0 });
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  const modLabel = isMac ? "⌘" : "Ctrl";
  // Modifier/middle-click → open the destination in a new tab / split
  // instead of replacing the focused view. Plain clicks fall through to
  // the default NavLink/Link navigation.
  const openTarget = useOpenTarget();

  // surface pinned artifacts directly in the
  // sidebar so the user can jump to a favorite without opening
  // the command palette. Pruning of stale IDs (artifacts deleted
  // elsewhere) happens lazily in the command palette's join, so
  // here we filter defensively against the live list.
  //
  // Build the artifact-by-id Map once per artifacts change, then
  // look pins up by Map.get instead of artifacts.find. Without the
  // Map this was O(pinnedIds.length * artifacts.length) per render
  // — negligible at small N, but scales poorly past a few hundred
  // artifacts. Mirrors the same pattern in `CommandPalette`. PR
  // #87.
  const artifactById = useMemo(() => {
    const map = new Map<string, ArtifactInfo>();
    for (const a of artifacts) map.set(a.id, a);
    return map;
  }, [artifacts]);
  const pinnedArtifacts = useMemo(
    () =>
      pinnedIds
        .map((id) => artifactById.get(id))
        .filter((a): a is ArtifactInfo => a !== undefined),
    [pinnedIds, artifactById],
  );

  // Explicit user choice for the "More tools" section, or `null` when
  // the user has not toggled it yet. Read once from localStorage on
  // mount; subsequent toggles update both this state and the stored
  // value so the choice survives relaunches.
  const [moreToolsChoice, setMoreToolsChoice] = useState<boolean | null>(
    () => readStoredMoreToolsExpanded(),
  );
  // Effective open state: an explicit user choice always wins;
  // otherwise the section defaults to collapsed under simplified
  // navigation and expanded otherwise.
  const moreToolsExpanded = moreToolsChoice ?? !settings.simplifiedNav;

  const toggleMoreTools = useCallback(() => {
    // Toggle relative to the current effective state, then persist. The
    // side effect lives in the event handler (not the state updater,
    // which must stay pure) so React can freely re-invoke the updater.
    const next = !moreToolsExpanded;
    setMoreToolsChoice(next);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(MORE_TOOLS_STORAGE_KEY, String(next));
      }
    } catch {
      // Persisting the choice is best-effort; the in-memory state
      // still drives this session even if storage is unavailable.
    }
  }, [moreToolsExpanded]);

  // Shared renderer for a single nav row so the primary list and the
  // secondary ("More tools") list stay visually identical. `showHint`
  // gates the keyboard-shortcut chip: it is suppressed for collapsed
  // secondary rows so a hidden destination never advertises a chip,
  // while the `aria-keyshortcuts` attribute is always present so
  // assistive tech still announces the shortcut.
  const renderNavItem = useCallback(
    (item: SidebarNavItem, showHint: boolean) => {
      const hint = SIDEBAR_SHORTCUT_HINTS[item.to];
      const openHandlers = openTarget(item.to);
      return (
        <li key={item.to}>
          <NavLink
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link-active" : ""}`
            }
            aria-keyshortcuts={hint ? `${modLabel}+${hint}` : undefined}
            title={
              collapsed
                ? item.label
                : `${item.label} — ${modLabel}-click: new tab, ${modLabel}+Shift-click: new split`
            }
            onClick={openHandlers.onClick}
            onAuxClick={openHandlers.onAuxClick}
          >
            <span className="sidebar-icon" aria-hidden="true">
              <item.Icon size={20} strokeWidth={1.75} />
            </span>
            {!collapsed && (
              <>
                <span className="sidebar-label">{item.label}</span>
                {showHint && hint && (
                  <span className="sidebar-kbd" aria-hidden="true">
                    {modLabel}+{hint}
                  </span>
                )}
              </>
            )}
          </NavLink>
        </li>
      );
    },
    [collapsed, modLabel, openTarget],
  );

  return (
    <nav
      className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}
      role="navigation"
      aria-label="Main navigation"
      data-collapsed={collapsed ? "true" : "false"}
    >
      <div className="sidebar-brand">
        <span className="sidebar-logo">T</span>
        {!collapsed && <span className="sidebar-title">Tessera</span>}
      </div>
      <ul className="sidebar-nav">
        {PRIMARY_SIDEBAR_ITEMS.map((item) => renderNavItem(item, true))}
      </ul>

      <div className="sidebar-more-tools">
        <button
          type="button"
          className="sidebar-link sidebar-more-toggle"
          onClick={toggleMoreTools}
          aria-expanded={moreToolsExpanded}
          aria-controls="sidebar-more-tools-list"
          title={collapsed ? "More tools" : undefined}
        >
          <span className="sidebar-icon" aria-hidden="true">
            {moreToolsExpanded ? (
              <ChevronDown size={20} strokeWidth={1.75} />
            ) : (
              <ChevronRight size={20} strokeWidth={1.75} />
            )}
          </span>
          {!collapsed && <span className="sidebar-label">More tools</span>}
        </button>
        {moreToolsExpanded && (
          <ul className="sidebar-nav" id="sidebar-more-tools-list">
            {SECONDARY_SIDEBAR_ITEMS.map((item) =>
              renderNavItem(item, true),
            )}
          </ul>
        )}
      </div>
      {!collapsed && pinnedArtifacts.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">Pinned</div>
          <ul className="sidebar-pinned-list">
            {pinnedArtifacts.map((artifact) => {
              const to = `/artifacts/${artifact.id}/edit`;
              const handlers = openTarget(to);
              return (
                <li key={artifact.id}>
                  <Link
                    to={to}
                    className="sidebar-link sidebar-pinned-link"
                    title={`${artifact.title || "(untitled)"} — ${modLabel}-click: new tab, ${modLabel}+Shift-click: new split`}
                    onClick={handlers.onClick}
                    onAuxClick={handlers.onAuxClick}
                  >
                    <Star size={14} fill="currentColor" aria-hidden="true" />
                    <span className="sidebar-label">
                      {artifact.title || "(untitled)"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {!collapsed && <KchatSidebarSection />}
      <style nonce={cspNonce}>{`
        .sidebar {
          width: 220px;
          min-width: 220px;
          height: 100vh;
          background: var(--color-bg-sidebar);
          border-right: 1px solid var(--color-border);
          display: flex;
          flex-direction: column;
          padding: var(--spacing-md) 0;
          overflow-y: auto;
        }
        .sidebar-collapsed {
          width: 60px;
          min-width: 60px;
        }
        .sidebar-brand {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-md) var(--spacing-lg);
          margin-bottom: var(--spacing-md);
        }
        .sidebar-collapsed .sidebar-brand {
          padding: var(--spacing-md);
          justify-content: center;
        }
        .sidebar-logo {
          width: 32px;
          height: 32px;
          background: var(--color-primary);
          color: var(--color-text-on-primary);
          border-radius: var(--radius-sm);
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: var(--font-weight-bold);
          font-size: var(--font-size-lg);
        }
        .sidebar-title {
          font-size: var(--font-size-lg);
          font-weight: var(--font-weight-semibold);
          color: var(--color-text-headline);
        }
        .sidebar-nav {
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 0 var(--spacing-sm);
        }
        .sidebar-link {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: 0.5rem var(--spacing-md);
          border-radius: var(--radius-input);
          color: var(--color-text-body);
          text-decoration: none;
          font-size: var(--font-size-sm);
          font-weight: var(--font-weight-medium);
          transition: all var(--transition-fast);
        }
        .sidebar-collapsed .sidebar-link {
          padding: 0.5rem;
          justify-content: center;
        }
        .sidebar-link:hover {
          background: var(--color-primary-light);
          color: var(--color-primary);
        }
        .sidebar-link-active {
          background: var(--color-primary-light);
          color: var(--color-primary);
          font-weight: var(--font-weight-semibold);
        }
        .sidebar-icon {
          width: 20px;
          text-align: center;
        }
        .sidebar-label {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sidebar-kbd {
          margin-left: auto;
          font-size: var(--font-size-xs);
          /* Body (not secondary) text: secondary on the bg-secondary chip
             only reaches ~4.4:1, just under the 4.5:1 AA floor for this
             12px text. Body text clears it in both themes. */
          color: var(--color-text-body);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          padding: 1px 4px;
          border-radius: 4px;
          background: var(--color-bg-secondary, transparent);
        }
        .sidebar-more-tools {
          margin-top: var(--spacing-xs);
          padding: var(--spacing-xs) var(--spacing-sm) 0;
          border-top: 1px solid var(--color-border);
        }
        .sidebar-more-tools .sidebar-nav {
          margin-top: 2px;
          padding: 0;
        }
        .sidebar-more-toggle {
          width: 100%;
          border: none;
          background: transparent;
          cursor: pointer;
          font: inherit;
          font-size: var(--font-size-sm);
          font-weight: var(--font-weight-medium);
          color: var(--color-text-secondary);
        }
        .sidebar-section {
          margin-top: var(--spacing-md);
          padding: 0 var(--spacing-sm);
        }
        .sidebar-section-label {
          padding: 0 var(--spacing-md);
          font-size: var(--font-size-xs);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--color-text-secondary);
          margin-bottom: var(--spacing-xs);
        }
        .sidebar-pinned-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .sidebar-pinned-link {
          color: var(--color-text-secondary);
        }
      `}</style>
    </nav>
  );
}
