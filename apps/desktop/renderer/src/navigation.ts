import {
  Home,
  FolderOpen,
  Plus,
  ClipboardList,
  CheckSquare,
  Zap,
  Eye,
  Settings,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Sidebar / global navigation source of truth.
 *
 * Both the visible sidebar order (`Sidebar.tsx`) and the
 * `Ctrl/Cmd+1..N` keyboard shortcuts (`useKeyboardShortcuts.ts`)
 * read from this single array, so they can never drift out of
 * sync — adding, removing, or reordering an entry here propagates
 * to both the visual list and the shortcut hint chips
 * automatically. Adding a new item just extends the shortcut range
 * (1-indexed) by one position; tests assert the invariants.
 */
export interface SidebarNavItem {
  /** Route path matched against react-router. */
  to: string;
  /** Human-readable label shown in the sidebar. */
  label: string;
  /** Lucide icon component rendered next to the label. */
  Icon: LucideIcon;
}

export const SIDEBAR_ITEMS: readonly SidebarNavItem[] = [
  { to: "/", label: "Home", Icon: Home },
  { to: "/sources", label: "Sources", Icon: FolderOpen },
  { to: "/create", label: "Create", Icon: Plus },
  { to: "/templates", label: "Templates", Icon: ClipboardList },
  { to: "/tasks", label: "Tasks", Icon: CheckSquare },
  { to: "/automations", label: "Automations", Icon: Zap },
  { to: "/vision", label: "Vision", Icon: Eye },
  { to: "/settings", label: "Settings", Icon: Settings },
];

/** Map of `"1"..."N"` → route path, derived from `SIDEBAR_ITEMS`
 *  display order. Used by `useKeyboardShortcuts` to navigate. */
export const SIDEBAR_NAV_BY_KEY: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      SIDEBAR_ITEMS.map((item, idx) => [String(idx + 1), item.to]),
    ),
  );

/** Inverse of `SIDEBAR_NAV_BY_KEY`: route path → `"1"..."N"`. Used
 *  by `Sidebar` to render the shortcut hint chip on each row. */
export const SIDEBAR_SHORTCUT_HINTS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      SIDEBAR_ITEMS.map((item, idx) => [item.to, String(idx + 1)]),
    ),
  );
