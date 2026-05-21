import { NavLink } from "react-router-dom";
import {
  Home,
  FolderOpen,
  Plus,
  ClipboardList,
  CheckSquare,
  Zap,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface NavItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

const navItems: NavItem[] = [
  { to: "/", label: "Home", Icon: Home },
  { to: "/sources", label: "Sources", Icon: FolderOpen },
  { to: "/create", label: "Create", Icon: Plus },
  { to: "/templates", label: "Templates", Icon: ClipboardList },
  { to: "/tasks", label: "Tasks", Icon: CheckSquare },
  { to: "/automations", label: "Automations", Icon: Zap },
  { to: "/settings", label: "Settings", Icon: Settings },
];

export default function Sidebar() {
  return (
    <nav className="sidebar" role="navigation" aria-label="Main navigation">
      <div className="sidebar-brand">
        <span className="sidebar-logo">T</span>
        <span className="sidebar-title">Tessera</span>
      </div>
      <ul className="sidebar-nav">
        {navItems.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `sidebar-link ${isActive ? "sidebar-link-active" : ""}`
              }
            >
              <span className="sidebar-icon" aria-hidden="true">
                <item.Icon size={20} strokeWidth={1.75} />
              </span>
              <span className="sidebar-label">{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
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
      `}</style>
    </nav>
  );
}
