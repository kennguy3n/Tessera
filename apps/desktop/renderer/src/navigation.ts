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

/**
 * Primary navigation tier — always visible in the sidebar, even in
 * "simplified navigation" mode. These four destinations cover the
 * core flow for a non-technical user: see what you have (Home),
 * connect material (Sources), make something (Create), and configure
 * the app (Settings). Templates is intentionally NOT here — the
 * Create page is the single entry point for making things, with the
 * full template browser tucked into the secondary tier.
 */
export const PRIMARY_SIDEBAR_ITEMS: readonly SidebarNavItem[] = [
  { to: "/", label: "Home", Icon: Home },
  { to: "/sources", label: "Sources", Icon: FolderOpen },
  { to: "/create", label: "Create", Icon: Plus },
  { to: "/settings", label: "Settings", Icon: Settings },
];

/**
 * Secondary navigation tier — power-user tools surfaced under the
 * collapsible "More tools" section in the sidebar. Hidden by default
 * for fresh installs (`simplifiedNav: true`) so new users aren't
 * overwhelmed, but always reachable via the toggle and via the
 * `Ctrl/Cmd+N` keyboard shortcuts (which read `SIDEBAR_ITEMS`).
 */
export const SECONDARY_SIDEBAR_ITEMS: readonly SidebarNavItem[] = [
  { to: "/templates", label: "Templates", Icon: ClipboardList },
  { to: "/tasks", label: "Tasks", Icon: CheckSquare },
  { to: "/automations", label: "Automations", Icon: Zap },
  { to: "/vision", label: "Vision", Icon: Eye },
];

/**
 * Full, ordered navigation list — the single source of truth for
 * keyboard shortcuts (`Ctrl/Cmd+1..N` in `useKeyboardShortcuts.ts`),
 * the command registry (`buildSidebarCommands`), and the shortcut
 * hint chips. It is the concatenation of the primary and secondary
 * tiers; the visible sidebar splits the same items across the two
 * tiers but the shortcut numbering follows this combined order so a
 * shortcut never changes meaning when the user collapses or expands
 * the "More tools" section.
 *
 * Kept as an explicit literal (rather than
 * `[...PRIMARY_SIDEBAR_ITEMS, ...SECONDARY_SIDEBAR_ITEMS]`) so the
 * canonical shortcut order is reviewable in one place and so adding
 * an item forces a deliberate decision about both its tier and its
 * shortcut index.
 */
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
