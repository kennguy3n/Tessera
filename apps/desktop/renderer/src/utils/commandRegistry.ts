/**
 * Declarative registry of every global Cmd+K command + its
 * associated keyboard shortcut.
 *
 * Why declarative?
 *
 *   - The keyboard-shortcuts help dialog (`KeyboardShortcutsHelp`)
 *     and the Cmd+K palette (`CommandPalette`) both render from
 *     this same source of truth, so they can never list
 *     contradictory key combinations.
 *   - The `useKeyboardShortcuts` hook iterates this registry to
 *     decide whether a given keydown event should fire a command,
 *     so adding a new shortcut is a one-entry addition here — not
 *     a switch-case edit in three files.
 *   - Tests can assert "every shortcut has a non-empty title",
 *     "no two shortcuts collide on the same chord", and "every
 *     navigation command points at a real sidebar route" by
 *     iterating the registry, instead of duplicating the chord
 *     list inside the test.
 *
 * Each entry maps to one of three action shapes:
 *
 *   - `navigate(to)`     — react-router navigation.
 *   - `dispatch(event)`  — fire a `window.dispatchEvent(CustomEvent)`
 *                          so far-away listeners (editor save, focus
 *                          the search bar, etc.) can hook in without
 *                          coupling to this module.
 *   - `callback`         — opaque function invoked by the runner.
 *                          Used for things like "open command
 *                          palette" / "toggle sidebar" where the
 *                          target lives in renderer-side state.
 *
 * The runner (in `useKeyboardShortcuts.ts`) walks the registry,
 * matches the chord against the keyboard event, and invokes the
 * matched entry's action. Only one entry can match per keydown
 * (validated by `assertNoChordCollisions` so we fail fast at
 * module load if a future contributor duplicates a chord).
 */

import { SIDEBAR_ITEMS } from "../navigation";
import { ARTIFACT_TYPES } from "../constants/artifactTypes";

/**
 * Categories used by both the Cmd+K palette grouping and the
 * keyboard-shortcuts help dialog. Ordered for display: navigation
 * first (most-frequent jumps), then actions (frequent in-editor
 * ops), then artifact/view/help (less frequent).
 */
export const COMMAND_CATEGORIES = [
  "Navigation",
  "Workspace",
  "Actions",
  "View",
  "Editor",
  "Artifact",
  "Help",
] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/**
 * A single keyboard chord. `mod` is `true` when the chord requires
 * the platform modifier (Cmd on macOS, Ctrl on others). `shift`
 * and `alt` default to `false`. `key` is matched case-insensitively
 * against `KeyboardEvent.key` so a chord like `{ mod: true, key:
 * "k" }` matches both lower-case `k` and the `K` produced when
 * Shift is held — but the chord then explicitly requires `shift:
 * true` to fire (i.e. `{ mod: true, shift: true, key: "k" }` is
 * distinct from `{ mod: true, key: "k" }`).
 */
export interface Chord {
  /** True when the chord requires Ctrl (or Cmd on macOS). */
  mod: boolean;
  /** True when the chord requires Shift. */
  shift?: boolean;
  /** True when the chord requires Alt. */
  alt?: boolean;
  /**
   * The non-modifier key. Matched against `KeyboardEvent.key`
   * case-insensitively. Common values: `"k"`, `"Escape"`, `"/"`,
   * `"1"` etc. Special chars use their JS name verbatim.
   */
  key: string;
}

/**
 * A single registry entry. Exactly one of `to`, `event`, or
 * `callback` is provided (enforced by the discriminated union
 * below) — the runner picks the right path at dispatch time.
 */
interface CommandBase {
  /** Stable id for tests and analytics. */
  id: string;
  title: string;
  description: string;
  category: CommandCategory;
  /**
   * The keyboard chord that triggers this command. `null` means
   * "no shortcut" (palette-only command, like `theme:toggle` if
   * we ever add one without a hotkey).
   */
  chord: Chord | null;
  /**
   * Extra keywords that should match the command via fuzzy search
   * in the palette beyond its `title` — e.g. the "Toggle theme"
   * command should match "dark", "light", "appearance".
   */
  keywords?: string[];
  /**
   * When true, this command does NOT appear in the Cmd+K palette
   * (e.g. "Open command palette" itself, "Escape" — the meta-
   * commands that only make sense as keyboard chords). It does
   * appear in the help dialog.
   */
  hiddenFromPalette?: boolean;
}

export type CommandNavigate = CommandBase & {
  kind: "navigate";
  to: string;
};

export type CommandDispatch = CommandBase & {
  kind: "dispatch";
  event: string;
  /**
   * Optional payload delivered as the `CustomEvent.detail` when the
   * runner fires `event`. Lets one event channel carry a parameter —
   * e.g. the "New document" / "New slide deck" commands all dispatch
   * `tessera:create-artifact` with `{ type }` so the single App-level
   * handler can branch on the artifact kind without a separate event
   * (and separate listener) per type.
   */
  detail?: Record<string, unknown>;
};

export type CommandCallback = CommandBase & {
  kind: "callback";
  callbackId: string;
};

export type Command = CommandNavigate | CommandDispatch | CommandCallback;

/**
 * IDs of callback-kind commands the runner must know how to
 * dispatch. Centralised here so a future contributor can't
 * forget to wire up a new callback in the runner (the
 * `assertCallbackIds` runtime check uses this list).
 */
export const KNOWN_CALLBACK_IDS = [
  "openCommandPalette",
  "openQuickSwitcher",
  "openShortcutsHelp",
  "toggleSidebar",
  "toggleTheme",
  // follow-up: react-router-side `navigate(-1)`
  // back-navigation. Lives as a callback (not a navigate-kind
  // command) because the target is a relative history pop, not a
  // concrete `to` string — the router cannot encode "the previous
  // page" as a path. Both the keyboard runner and the palette
  // resolve this id to `navigate(-1)` via their respective scopes.
  "goBack",
] as const;
export type KnownCallbackId = (typeof KNOWN_CALLBACK_IDS)[number];

/**
 * Build the sidebar-navigation commands from the single source of
 * truth in `../navigation.ts`. Adding a new sidebar entry there
 * automatically extends the palette + shortcuts registry.
 */
function buildSidebarCommands(): Command[] {
  return SIDEBAR_ITEMS.map((item, i): Command => {
    const idx = i + 1;
    return {
      id: `nav:${item.to}`,
      title: `Go to ${item.label}`,
      description: `Navigate to the ${item.label} page`,
      category: "Navigation",
      chord:
        idx <= 9
          ? { mod: true, key: String(idx) }
          : null,
      keywords: [item.label.toLowerCase()],
      kind: "navigate",
      to: item.to,
    };
  });
}

/**
 * "Create <kind>" commands, one per {@link ARTIFACT_TYPES} entry.
 * Each dispatches the single `tessera:create-artifact` channel with a
 * `{ type }` detail; the App-level handler creates a blank artifact
 * via `window.tessera.artifacts.create` and opens its editor. Kept
 * data-driven so adding an artifact type to the substrate surfaces a
 * palette command for free.
 */
function buildCreateArtifactCommands(): Command[] {
  return ARTIFACT_TYPES.map(
    (spec): Command => ({
      id: `create:${spec.id}`,
      title: `New ${spec.label.toLowerCase()}`,
      description: `Create a blank ${spec.label.toLowerCase()} and open the editor`,
      category: "Artifact",
      chord: null,
      keywords: ["create", "new", spec.label.toLowerCase(), ...spec.keywords],
      kind: "dispatch",
      event: "tessera:create-artifact",
      detail: { type: spec.id },
    }),
  );
}

/**
 * The full command registry. Ordered roughly by frequency-of-use
 * within each category so that an empty Cmd+K input (which shows
 * commands in registry order) surfaces the most-useful items
 * first.
 */
export function buildCommandRegistry(): readonly Command[] {
  const sidebar = buildSidebarCommands();
  const createArtifacts = buildCreateArtifactCommands();
  const rest: Command[] = [
    // --- Workspace (split panes / tabs) ---
    // Dispatch-kind: each fires a `tessera:*` event that
    // `WorkspaceProvider` listens for and routes to the pure pane-tree
    // reducers. Chords follow Obsidian where it has one (Cmd+\ split
    // right, Cmd+Shift+\ split down) and otherwise pick collision-free
    // bindings (validated by `findChordCollisions`).
    {
      id: "workspace:newTab",
      title: "New tab",
      description: "Open a new tab in the focused pane",
      category: "Workspace",
      chord: { mod: true, key: "t" },
      keywords: ["tab", "open", "new"],
      kind: "dispatch",
      event: "tessera:new-tab",
    },
    {
      id: "workspace:closeTab",
      title: "Close tab",
      description: "Close the focused pane's active tab",
      category: "Workspace",
      chord: { mod: true, key: "w" },
      keywords: ["tab", "close"],
      kind: "dispatch",
      event: "tessera:close-tab",
    },
    {
      id: "workspace:nextTab",
      title: "Next tab",
      description: "Activate the next tab in the focused pane",
      category: "Workspace",
      chord: { mod: true, shift: true, key: "]" },
      keywords: ["tab", "next", "cycle", "forward"],
      kind: "dispatch",
      event: "tessera:next-tab",
    },
    {
      id: "workspace:prevTab",
      title: "Previous tab",
      description: "Activate the previous tab in the focused pane",
      category: "Workspace",
      chord: { mod: true, shift: true, key: "[" },
      keywords: ["tab", "previous", "cycle", "back"],
      kind: "dispatch",
      event: "tessera:prev-tab",
    },
    {
      id: "workspace:splitRight",
      title: "Split right",
      description: "Split the focused pane into a side-by-side pane",
      category: "Workspace",
      chord: { mod: true, key: "\\" },
      keywords: ["split", "pane", "vertical", "right", "side"],
      kind: "dispatch",
      event: "tessera:split-right",
    },
    {
      id: "workspace:splitDown",
      title: "Split down",
      description: "Split the focused pane into a stacked pane",
      category: "Workspace",
      chord: { mod: true, shift: true, key: "\\" },
      keywords: ["split", "pane", "horizontal", "down", "stack"],
      kind: "dispatch",
      event: "tessera:split-down",
    },
    {
      id: "workspace:focusNextPane",
      title: "Focus next pane",
      description: "Move focus to the next pane",
      category: "Workspace",
      chord: { mod: true, key: "j" },
      keywords: ["pane", "focus", "next", "cycle"],
      kind: "dispatch",
      event: "tessera:focus-next-pane",
    },
    {
      id: "workspace:focusPrevPane",
      title: "Focus previous pane",
      description: "Move focus to the previous pane",
      category: "Workspace",
      chord: { mod: true, shift: true, key: "j" },
      keywords: ["pane", "focus", "previous", "cycle"],
      kind: "dispatch",
      event: "tessera:focus-prev-pane",
    },
    {
      id: "workspace:maximizePane",
      title: "Maximize / restore pane",
      description: "Toggle the focused pane to fill the workspace",
      category: "Workspace",
      chord: { mod: true, key: "m" },
      keywords: ["pane", "maximize", "restore", "zoom", "full", "expand"],
      kind: "dispatch",
      event: "tessera:maximize-pane",
    },
    {
      id: "workspace:evenSplit",
      title: "Even split sizes",
      description: "Rebalance all panes to equal sizes",
      category: "Workspace",
      chord: { mod: true, shift: true, key: "e" },
      keywords: ["split", "pane", "even", "equal", "balance", "rebalance"],
      kind: "dispatch",
      event: "tessera:even-split",
    },
    {
      id: "workspace:toggleStacked",
      title: "Toggle stacked tabs",
      description: "Switch the focused pane between row and stacked tabs",
      category: "Workspace",
      chord: { mod: true, shift: true, key: "t" },
      keywords: ["tab", "stack", "stacked", "vertical", "pane"],
      kind: "dispatch",
      event: "tessera:toggle-stacked",
    },
    {
      id: "workspace:closeOthers",
      title: "Close other tabs",
      description: "Close every tab in the focused pane except the active one",
      category: "Workspace",
      chord: null,
      keywords: ["tab", "close", "others", "rest"],
      kind: "dispatch",
      event: "tessera:close-others",
    },
    {
      id: "workspace:closeToRight",
      title: "Close tabs to the right",
      description: "Close all tabs after the active tab in the focused pane",
      category: "Workspace",
      chord: null,
      keywords: ["tab", "close", "right", "trailing"],
      kind: "dispatch",
      event: "tessera:close-to-right",
    },

    // --- Meta / palette ---
    {
      id: "palette:open",
      title: "Open command palette",
      description: "Show the Cmd+K command palette",
      category: "Help",
      chord: { mod: true, key: "k" },
      keywords: ["cmd", "ctrl", "palette", "menu"],
      hiddenFromPalette: true,
      kind: "callback",
      callbackId: "openCommandPalette",
    },
    {
      id: "palette:openShiftP",
      title: "Open command palette (alt binding)",
      description: "Alias chord matching VSCode / Sublime Text",
      category: "Help",
      chord: { mod: true, shift: true, key: "p" },
      keywords: ["cmd", "ctrl", "palette"],
      hiddenFromPalette: true,
      kind: "callback",
      callbackId: "openCommandPalette",
    },
    {
      id: "palette:openP",
      title: "Open command palette (Ctrl/Cmd+P)",
      description: "Alias chord — open the command palette",
      category: "Help",
      chord: { mod: true, key: "p" },
      keywords: ["cmd", "ctrl", "palette", "menu"],
      hiddenFromPalette: true,
      kind: "callback",
      callbackId: "openCommandPalette",
    },
    {
      id: "palette:quickSwitcher",
      title: "Quick switch",
      description:
        "Fuzzy-find and open any source, artifact, template, automation, task, or page",
      category: "Navigation",
      // Obsidian's quick-switcher chord. Distinct from the Cmd+P / Cmd+K
      // command palette so muscle memory carries across apps.
      chord: { mod: true, key: "o" },
      keywords: ["go to", "jump", "switch", "fuzzy", "find", "recent", "open"],
      kind: "callback",
      callbackId: "openQuickSwitcher",
    },
    {
      id: "help:shortcuts",
      title: "Show keyboard shortcuts",
      description: "Open the cheatsheet of every keyboard shortcut",
      category: "Help",
      chord: { mod: true, key: "/" },
      keywords: ["help", "cheatsheet", "hotkeys", "keys"],
      kind: "callback",
      callbackId: "openShortcutsHelp",
    },
    {
      id: "help:shortcutsQuestion",
      title: "Show keyboard shortcuts (?)",
      description: "Alias — press ? to open the keyboard cheatsheet",
      category: "Help",
      // Bare "?" with no platform modifier, the GitHub / Obsidian
      // discoverability convention. The key is "?" (not "/") because
      // Shift+/ emits `event.key === "?"`; `shift: true` matches the
      // US-layout chord that produces it. Suppressed while typing
      // (it's not in the runner's typing-override set).
      chord: { mod: false, shift: true, key: "?" },
      keywords: ["help", "cheatsheet", "hotkeys", "keys"],
      hiddenFromPalette: true,
      kind: "callback",
      callbackId: "openShortcutsHelp",
    },

    // --- View ---
    {
      id: "view:toggleSidebar",
      title: "Toggle sidebar",
      description: "Collapse or expand the sidebar",
      category: "View",
      chord: { mod: true, key: "b" },
      keywords: ["hide", "show", "nav"],
      kind: "callback",
      callbackId: "toggleSidebar",
    },
    {
      id: "view:toggleTheme",
      title: "Toggle theme",
      description: "Switch between light and dark mode",
      category: "View",
      chord: { mod: true, shift: true, key: "l" },
      keywords: ["dark", "light", "appearance", "mode"],
      kind: "callback",
      callbackId: "toggleTheme",
    },
    {
      id: "view:focusSearch",
      title: "Focus search",
      description: "Move keyboard focus to the search input",
      category: "View",
      chord: { mod: true, key: "f" },
      keywords: ["find", "search", "filter"],
      kind: "dispatch",
      event: "tessera:focus-search",
    },
    {
      id: "view:globalSearch",
      title: "Global search",
      description: "Search across artifacts and sources",
      category: "View",
      chord: { mod: true, shift: true, key: "f" },
      keywords: ["everything", "across", "find"],
      kind: "callback",
      callbackId: "openCommandPalette",
    },

    // --- Actions ---
    {
      id: "action:newArtifact",
      title: "New artifact",
      description: "Open the Create page",
      category: "Actions",
      chord: { mod: true, key: "n" },
      keywords: ["create", "add"],
      kind: "navigate",
      to: "/create",
    },
    {
      id: "action:newFromTemplate",
      title: "New from template",
      description: "Browse templates and create an artifact",
      category: "Actions",
      chord: { mod: true, shift: true, key: "n" },
      keywords: ["create", "template"],
      kind: "navigate",
      to: "/templates",
    },
    {
      id: "action:save",
      title: "Save",
      description: "Persist the current editor's contents",
      category: "Editor",
      chord: { mod: true, key: "s" },
      keywords: ["persist", "write"],
      kind: "dispatch",
      event: "tessera:save",
    },
    {
      id: "action:export",
      title: "Export",
      description: "Export the current artifact",
      category: "Editor",
      chord: { mod: true, key: "e" },
      keywords: ["save as", "download"],
      kind: "dispatch",
      event: "tessera:export",
    },
    {
      id: "action:print",
      title: "Print",
      description: "Open the system print dialog for the current view",
      category: "Editor",
      // Cmd/Ctrl+P is the command palette in this app (Obsidian
      // convention), so Print takes the secondary Cmd/Ctrl+Alt+P chord.
      // `chordMatchesEvent` matches it by physical key code so macOS
      // Option-key composition (⌥P → "π") doesn't break it.
      chord: { mod: true, alt: true, key: "p" },
      keywords: ["print", "pdf", "paper", "hard copy"],
      kind: "dispatch",
      event: "tessera:print",
    },
    {
      id: "action:openSettings",
      title: "Open settings",
      description: "Go to the settings page",
      category: "Navigation",
      chord: { mod: true, key: "," },
      keywords: ["preferences", "config"],
      kind: "navigate",
      to: "/settings",
    },
    {
      id: "nav:settings#appearance",
      title: "Appearance & theme settings",
      description: "Jump to the theme / general section of settings",
      category: "Navigation",
      chord: null,
      keywords: ["theme", "dark", "light", "appearance", "general"],
      kind: "navigate",
      to: "/settings#appearance",
    },
    {
      id: "nav:settings#performance",
      title: "Performance settings",
      description: "Jump to the performance / resource section of settings",
      category: "Navigation",
      chord: null,
      keywords: ["performance", "ram", "gpu", "model", "resource", "memory"],
      kind: "navigate",
      to: "/settings#performance",
    },
    {
      id: "nav:settings#provider",
      title: "External AI provider settings",
      description: "Jump to the external-provider (BYOK) section of settings",
      category: "Navigation",
      chord: null,
      keywords: ["openai", "anthropic", "api key", "byok", "provider", "cloud"],
      kind: "navigate",
      to: "/settings#provider",
    },
    {
      id: "nav:settings#backup",
      title: "Backup & restore settings",
      description: "Jump to the backup / workspace-export section of settings",
      category: "Navigation",
      chord: null,
      keywords: ["backup", "restore", "export workspace", "bundle", "recovery"],
      kind: "navigate",
      to: "/settings#backup",
    },
    {
      id: "nav:connectors",
      title: "Manage connectors",
      description: "Open the connectors on the Sources page",
      category: "Navigation",
      chord: null,
      keywords: [
        "connectors",
        "google drive",
        "onedrive",
        "notion",
        "jira",
        "confluence",
        "figma",
        "trello",
        "gitlab",
        "oauth",
        "integrations",
        "sync",
      ],
      kind: "navigate",
      to: "/sources#connectors",
    },

    // --- Substrate / memory (bridge surfaces these; the App-level
    // handlers call window.tessera.substrate and toast the result). ---
    {
      id: "substrate:runDecaySweep",
      title: "Run memory decay sweep",
      description: "Recompute retention and apply decay transitions now",
      category: "Actions",
      chord: null,
      keywords: ["decay", "memory", "retention", "sweep", "substrate", "forget"],
      kind: "dispatch",
      event: "tessera:run-decay-sweep",
    },
    {
      id: "substrate:triggerSynthesis",
      title: "Synthesize memory",
      description: "Produce and persist a deterministic synthesis for the workspace",
      category: "Actions",
      chord: null,
      keywords: ["synthesis", "synthesize", "summary", "memory", "substrate"],
      kind: "dispatch",
      event: "tessera:trigger-synthesis",
    },

    // --- Artifact-context (work even outside editor; the editor
    // wires the events into its action toolbar). ---
    {
      id: "artifact:pin",
      title: "Pin / unpin current artifact",
      description: "Toggle the favorite (pin) state for the open artifact",
      category: "Artifact",
      chord: { mod: true, shift: true, key: "d" },
      keywords: ["favorite", "star", "bookmark"],
      kind: "dispatch",
      event: "tessera:toggle-pin",
    },
    {
      id: "artifact:duplicate",
      title: "Duplicate current artifact",
      description: "Create a copy of the open artifact",
      category: "Artifact",
      chord: { mod: true, key: "d" },
      keywords: ["copy", "clone"],
      kind: "dispatch",
      event: "tessera:duplicate",
    },
    {
      id: "artifact:delete",
      title: "Delete current artifact",
      description: "Remove the open artifact (with confirm)",
      category: "Artifact",
      chord: { mod: true, key: "Backspace" },
      keywords: ["remove", "trash"],
      kind: "dispatch",
      event: "tessera:delete",
    },
    {
      id: "artifact:share",
      title: "Share to KChat",
      description: "Share the current artifact to a KChat channel",
      category: "Artifact",
      chord: { mod: true, shift: true, key: "s" },
      keywords: ["share", "kchat", "send"],
      kind: "dispatch",
      event: "tessera:share",
    },
    {
      id: "artifact:goBack",
      title: "Go back",
      description: "Navigate to the previous page",
      category: "Navigation",
      chord: { mod: true, key: "[" },
      keywords: ["back", "history"],
      kind: "callback",
      // Bound to `goBack` (not `openCommandPalette`) so the runner +
      // palette both call `navigate(-1)` for actual
      // browser-style back navigation. Devin Review PR #87
      // follow-up.
      callbackId: "goBack",
    },
  ];
  return [...sidebar, ...createArtifacts, ...rest];
}

/**
 * The canonical, immutable command registry exported for use by
 * the palette, the keyboard-shortcuts help dialog, and the
 * `useKeyboardShortcuts` runner. Always import this — never
 * rebuild via `buildCommandRegistry()` in a hot path — so the
 * registry's reference identity is stable across renders for
 * downstream `useMemo` consumers.
 */
export const COMMAND_REGISTRY: ReadonlyArray<Command> = Object.freeze(
  buildCommandRegistry(),
);

/**
 * Format a chord for display in a UI badge (e.g. "⌘K" on macOS,
 * "Ctrl+K" on Linux/Windows). Capitalises single-letter keys so
 * the badge reads correctly.
 *
 * The `isMac` flag is injected (not auto-detected) so render
 * paths can compute it once at the call site and avoid the
 * `navigator.platform` access being re-evaluated for every
 * row.
 */
export function formatChord(chord: Chord, isMac: boolean): string {
  if (!chord) return "";
  const parts: string[] = [];
  if (chord.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (chord.shift) parts.push(isMac ? "⇧" : "Shift");
  if (chord.alt) parts.push(isMac ? "⌥" : "Alt");
  const keyDisplay = formatKey(chord.key);
  parts.push(keyDisplay);
  return isMac ? parts.join("") : parts.join("+");
}

function formatKey(key: string): string {
  if (key.length === 1) return key.toUpperCase();
  if (key === "Backspace") return "⌫";
  if (key === "Escape") return "Esc";
  if (key === "ArrowUp") return "↑";
  if (key === "ArrowDown") return "↓";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  return key;
}

/**
 * Returns true when the given keyboard event matches the chord.
 * Used by the `useKeyboardShortcuts` runner to walk the registry.
 *
 * Matching rules:
 *
 *   - `mod` — matches `event.metaKey || event.ctrlKey` (so the
 *     same chord works on macOS and Linux/Windows).
 *   - `shift` / `alt` — exact match against the event's modifier
 *     state. Absent in the chord means "must NOT be held".
 *   - `key` — case-insensitive match against `event.key`. Special
 *     keys like `"Escape"` / `"Backspace"` match verbatim.
 */
export function chordMatchesEvent(
  chord: Chord,
  event: KeyboardEvent,
): boolean {
  if (chord.mod !== (event.metaKey || event.ctrlKey)) return false;
  if ((chord.shift ?? false) !== event.shiftKey) return false;
  if ((chord.alt ?? false) !== event.altKey) return false;
  if (chord.key.length === 1) {
    if (event.key.toLowerCase() === chord.key.toLowerCase()) return true;
    // macOS composes Option/Alt + letter into a different glyph
    // (e.g. ⌥P emits `event.key === "π"`), so an alt chord's letter
    // never matches `event.key`. Fall back to the layout-independent
    // physical key code for alt letter chords so they stay reachable.
    // Scoped to alt chords; non-alt chords keep layout-aware matching.
    if (chord.alt && /^[a-z]$/i.test(chord.key)) {
      return event.code === `Key${chord.key.toUpperCase()}`;
    }
    return false;
  }
  return event.key === chord.key;
}

/**
 * Group commands by `category`, preserving registry order
 * within each category and `COMMAND_CATEGORIES` order across
 * categories.
 */
export function groupCommandsByCategory(
  commands: ReadonlyArray<Command>,
): Record<CommandCategory, Command[]> {
  const result = COMMAND_CATEGORIES.reduce(
    (acc, cat) => {
      acc[cat] = [];
      return acc;
    },
    {} as Record<CommandCategory, Command[]>,
  );
  for (const cmd of commands) {
    result[cmd.category].push(cmd);
  }
  return result;
}

/**
 * Validate that no two chords in the registry collide. Called at
 * module load by the runner; throws on collision so we fail fast
 * during development rather than silently dispatching the wrong
 * command. The chord serialiser includes every modifier so e.g.
 * `Cmd+K` and `Cmd+Shift+K` are distinct.
 */
export function findChordCollisions(
  commands: ReadonlyArray<Command>,
): Array<{ chord: string; ids: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const cmd of commands) {
    if (!cmd.chord) continue;
    const key = serializeChord(cmd.chord);
    const existing = buckets.get(key) ?? [];
    existing.push(cmd.id);
    buckets.set(key, existing);
  }
  const collisions: Array<{ chord: string; ids: string[] }> = [];
  for (const [chord, ids] of buckets) {
    if (ids.length > 1) collisions.push({ chord, ids });
  }
  return collisions;
}

function serializeChord(chord: Chord): string {
  return [
    chord.mod ? "mod" : "",
    chord.shift ? "shift" : "",
    chord.alt ? "alt" : "",
    chord.key.toLowerCase(),
  ]
    .filter(Boolean)
    .join("+");
}
