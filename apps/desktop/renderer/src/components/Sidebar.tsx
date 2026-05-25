import { NavLink } from "react-router-dom";
import { SIDEBAR_ITEMS, SIDEBAR_SHORTCUT_HINTS } from "../navigation";
import KchatSidebarSection from "./KchatSidebarSection";

export default function Sidebar() {
  return (
    <nav className="sidebar" role="navigation" aria-label="Main navigation">
      <div className="sidebar-brand">
        <span className="sidebar-logo">T</span>
        <span className="sidebar-title">Tessera</span>
      </div>
      <ul className="sidebar-nav">
        {SIDEBAR_ITEMS.map((item) => {
          const hint = SIDEBAR_SHORTCUT_HINTS[item.to];
          const isMac =
            typeof navigator !== "undefined" &&
            /Mac|iPhone|iPad/.test(navigator.platform);
          const modLabel = isMac ? "⌘" : "Ctrl";
          return (
            <li key={item.to}>
              <NavLink
                to={item.to}
                end={item.to === "/"}
                className={({ isActive }) =>
                  `sidebar-link ${isActive ? "sidebar-link-active" : ""}`
                }
                aria-keyshortcuts={hint ? `${modLabel}+${hint}` : undefined}
              >
                <span className="sidebar-icon" aria-hidden="true">
                  <item.Icon size={20} strokeWidth={1.75} />
                </span>
                <span className="sidebar-label">{item.label}</span>
                {hint && (
                  <span className="sidebar-kbd" aria-hidden="true">
                    {modLabel}+{hint}
                  </span>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <KchatSidebarSection />
      <style>{`
        .sidebar {
          width: 220px;
          min-width: 220px;
          height: 100vh;
          background: var(--color-bg-sidebar);
          border-right: 1px solid var(--color-border);
          display: flex;
          flex-direction: column;
          padding: var(--spacing-md) 0;
        }
        .sidebar-brand {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-md) var(--spacing-lg);
          margin-bottom: var(--spacing-md);
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
      `}</style>
    </nav>
  );
}
