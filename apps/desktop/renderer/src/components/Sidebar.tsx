import { Link, NavLink } from "react-router-dom";
import { Star } from "lucide-react";
import { SIDEBAR_ITEMS, SIDEBAR_SHORTCUT_HINTS } from "../navigation";
import KchatSidebarSection from "./KchatSidebarSection";
import { useCspNonce } from "../utils/cspNonce";
import { useArtifactList } from "../hooks/useArtifacts";
import { usePinnedArtifacts } from "../hooks/usePinnedArtifacts";

interface SidebarProps {
  /**
   * Phase 18 Task 19 (Cmd+B): when true, render the sidebar as a
   * narrow icon-only rail. Driven by the `tessera:toggle-sidebar`
   * custom event from the keyboard-shortcut runner; default false.
   */
  collapsed?: boolean;
}

export default function Sidebar({ collapsed = false }: SidebarProps) {
  const cspNonce = useCspNonce();
  const { artifacts } = useArtifactList();
  const { pinnedIds } = usePinnedArtifacts();
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);
  const modLabel = isMac ? "⌘" : "Ctrl";

  // Phase 18 Task 16: surface pinned artifacts directly in the
  // sidebar so the user can jump to a favorite without opening
  // the command palette. Pruning of stale IDs (artifacts deleted
  // elsewhere) happens lazily in the command palette's join, so
  // here we filter defensively against the live list.
  const pinnedArtifacts = pinnedIds
    .map((id) => artifacts.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

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
        {SIDEBAR_ITEMS.map((item) => {
          const hint = SIDEBAR_SHORTCUT_HINTS[item.to];
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `sidebar-link ${isActive ? "sidebar-link-active" : ""}`
                }
                aria-keyshortcuts={hint ? `${modLabel}+${hint}` : undefined}
                title={collapsed ? item.label : undefined}
              >
                <span className="sidebar-icon" aria-hidden="true">
                  <item.Icon size={20} strokeWidth={1.75} />
                </span>
                {!collapsed && (
                  <>
                    <span className="sidebar-label">{item.label}</span>
                    {hint && (
                      <span className="sidebar-kbd" aria-hidden="true">
                        {modLabel}+{hint}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
      {!collapsed && pinnedArtifacts.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-label">Pinned</div>
          <ul className="sidebar-pinned-list">
            {pinnedArtifacts.map((artifact) => (
              <li key={artifact.id}>
                <Link
                  to={`/artifacts/${artifact.id}/edit`}
                  className="sidebar-link sidebar-pinned-link"
                >
                  <Star size={14} fill="currentColor" aria-hidden="true" />
                  <span className="sidebar-label">
                    {artifact.title || "(untitled)"}
                  </span>
                </Link>
              </li>
            ))}
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
          color: var(--color-text-secondary);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          padding: 1px 4px;
          border-radius: 4px;
          background: var(--color-bg-secondary, transparent);
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
