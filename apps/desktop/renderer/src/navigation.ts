import {
  Home,
  FolderOpen,
  Plus,
  ClipboardList,
  CheckSquare,
  Zap,
  Eye,
  Settings,
  Brain,
  Network,
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
  { to: "/memory", label: "Memory", Icon: Brain },
  { to: "/knowledge", label: "Knowledge Graph", Icon: Network },
];

/**
 * Full, ordered navigation list — the single source of truth for
 * keyboard shortcuts (`Ctrl/Cmd+1..N` in `useKeyboardShortcuts.ts`),
 * the command registry (`buildSidebarCommands`), and the shortcut
 * hint chips.
 *
 * This order is the original, pre-tiering sidebar order (Home,
 * Sources, Create, Templates, Tasks, Automations, Vision, Settings)
 * and is intentionally NOT `[...PRIMARY, ...SECONDARY]`: a naive
 * concatenation would move Settings from index 8 to index 4 and
 * silently reassign every `Ctrl/Cmd+N` shortcut. Preserving the
 * legacy order keeps each shortcut pinned to the same destination
 * regardless of which tier an item now lives in, so collapsing or
 * expanding "More tools" never changes what a shortcut does.
 *
 * Kept as an explicit literal (rather than derived from the two
 * tier arrays) so the canonical shortcut order is reviewable in one
 * place and so adding an item forces a deliberate decision about
 * both its tier and its shortcut index. `navigation.test.ts` pins
 * this order and asserts every tier item appears here, so the three
 * lists can't silently drift.
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
  { to: "/memory", label: "Memory", Icon: Brain },
  { to: "/knowledge", label: "Knowledge Graph", Icon: Network },
];

/**
 * Highest 1-indexed sidebar position that can own a `Ctrl/Cmd+N`
 * shortcut. A keyboard chord is a single non-modifier key, and the
 * only digit keys are `0`–`9`; there is no way to press "10" as one
 * keystroke (a keydown reports `key: "1"` then `key: "0"`, never
 * `"10"`). So positions 1..9 get a numeric chord and anything beyond
 * that is reachable via the sidebar click + the Cmd+K palette, but
 * carries NO shortcut hint.
 *
 * This is the single source of truth for the cutoff: `commandRegistry`
 * imports it to decide which sidebar commands get a chord, and the two
 * maps below use it so the hint chips can never advertise a chord the
 * registry doesn't actually bind. (Devin Review PR #120 caught the
 * 10th item — Knowledge Graph — rendering a dead "Ctrl+10" hint.)
 */
export const MAX_SIDEBAR_SHORTCUT_INDEX = 9;

/** Map of `"1".."9"` → route path, derived from `SIDEBAR_ITEMS`
 *  display order. Used by `useKeyboardShortcuts` to navigate. Only
 *  the first `MAX_SIDEBAR_SHORTCUT_INDEX` items get a key — see that
 *  constant for why 10+ are intentionally excluded. */
export const SIDEBAR_NAV_BY_KEY: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      SIDEBAR_ITEMS.slice(0, MAX_SIDEBAR_SHORTCUT_INDEX).map((item, idx) => [
        String(idx + 1),
        item.to,
      ]),
    ),
  );

/** Inverse of `SIDEBAR_NAV_BY_KEY`: route path → `"1".."9"`. Used
 *  by `Sidebar` to render the shortcut hint chip on each row. Items
 *  past `MAX_SIDEBAR_SHORTCUT_INDEX` are absent here, so they render
 *  no hint chip (matching the registry, which binds them no chord). */
export const SIDEBAR_SHORTCUT_HINTS: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      SIDEBAR_ITEMS.slice(0, MAX_SIDEBAR_SHORTCUT_INDEX).map((item, idx) => [
        item.to,
        String(idx + 1),
      ]),
    ),
  );
