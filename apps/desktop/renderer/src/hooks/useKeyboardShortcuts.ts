/**
 * Tessera's global keyboard shortcut runner.
 *
 * Registered once at the app root by `App.tsx`. The handler walks
 * `COMMAND_REGISTRY` (the single source of truth shared with the
 * Cmd+K palette and the shortcuts-help dialog) and dispatches the
 * first matching command. This guarantees a chord can never be
 * bound to one action in the palette and a different action by a
 * keydown listener — they read from the same list.
 *
 * Each shortcut is implemented as one keydown handler that consults
 * `e.metaKey || e.ctrlKey` so both macOS (Cmd) and Linux/Windows
 * (Ctrl) work. We intentionally skip shortcuts when the user is
 * typing inside a textbox / contenteditable so we don't shadow
 * native browser shortcuts like Ctrl+A inside an editor — except
 * Escape, Cmd+S, Cmd+E, Cmd+K (palette), and Cmd+/ (help), which
 * we still capture from anywhere so users can save, export, open
 * the palette, or open the help dialog from inside an editor.
 *
 * The runner is intentionally renderer-only — all bindings are
 * derived from the registry, so adding a new shortcut is a one-
 * entry change in `commandRegistry.ts`. No edits here are
 * required.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  type Command,
  chordMatchesEvent,
  COMMAND_REGISTRY,
  findChordCollisions,
} from "../utils/commandRegistry";
import { useSettings, useUpdateSetting } from "./useSettings";

/**
 * Set of chords that fire even when the focused element is a
 * typing target (input / textarea / contenteditable). These are
 * the "meta" shortcuts the user expects to work from anywhere —
 * Save, Export, palette opens, help. Everything else is suppressed
 * so we never shadow native browser typing behaviour or rich-text-
 * editor shortcuts.
 *
 * NOTE on `view:toggleSidebar` (Cmd+B): intentionally EXCLUDED.
 * TipTap's `StarterKit` (`DocumentEditor.tsx`) binds Cmd+B to the
 * bold-text mark. Adding `view:toggleSidebar` to this set caused
 * Cmd+B inside a document to both apply bold AND collapse the
 * sidebar — a disruptive UX bug surfaced by PR #87 Devin Review
 * (round 3). The sidebar toggle is a chrome-level nav
 * action, not an editor action, so suppressing it inside editors
 * is the architecturally correct fix (matches how every native
 * desktop app handles Cmd+B inside rich-text fields).
 *
 * NOTE on `palette:open` (Cmd+K): intentionally KEPT. TipTap's
 * `Link` extension also binds Cmd+K but the command palette is
 * the canonical "go anywhere from anywhere" entry point (matches
 * the VSCode / Sublime / Linear pattern). Users typing in a
 * document still need a way to summon the palette without
 * leaving the editor first. PR #87
 * round 3.
 */
const TYPING_OVERRIDE_COMMAND_IDS = new Set<string>([
  "action:save",
  "action:export",
  "palette:open",
  "palette:openShiftP",
  "palette:quickSwitcher",
  "help:shortcuts",
]);

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return false;
}

// Module-load self-check: throws if two commands share a chord.
// Documented in `findChordCollisions`. Caught here (not at first
// keydown) so a broken registry surfaces during dev / test rather
// than via a silent dispatch-to-the-wrong-action bug.
{
  const collisions = findChordCollisions(COMMAND_REGISTRY);
  if (collisions.length > 0) {
    const detail = collisions
      .map((c) => `${c.chord}: ${c.ids.join(", ")}`)
      .join("; ");
    throw new Error(`Duplicate keyboard chord(s) in registry: ${detail}`);
  }
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate();
  const { settings } = useSettings();
  const { update: updateSetting } = useUpdateSetting();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Escape is a global signal — modals own their own keydown
      // listener but we still emit a tessera:escape event so far-
      // away listeners (search bars, the command palette) can
      // hook into it without coupling.
      if (e.key === "Escape" && !(e.metaKey || e.ctrlKey)) {
        window.dispatchEvent(new CustomEvent("tessera:escape"));
        return;
      }

      const typing = isTypingTarget(e.target);

      // Walk the registry and dispatch the first matching command.
      let matched: Command | null = null;
      for (const cmd of COMMAND_REGISTRY) {
        if (!cmd.chord) continue;
        if (!chordMatchesEvent(cmd.chord, e)) continue;
        if (typing && !TYPING_OVERRIDE_COMMAND_IDS.has(cmd.id)) continue;
        matched = cmd;
        break;
      }
      if (!matched) return;

      e.preventDefault();

      if (matched.kind === "navigate") {
        navigate(matched.to);
        return;
      }
      if (matched.kind === "dispatch") {
        window.dispatchEvent(new CustomEvent(matched.event));
        return;
      }
      if (matched.kind === "callback") {
        switch (matched.callbackId) {
          case "openCommandPalette":
            window.dispatchEvent(
              new CustomEvent("tessera:open-palette", {
                detail: { mode: "full" },
              }),
            );
            return;
          case "openQuickSwitcher":
            window.dispatchEvent(
              new CustomEvent("tessera:open-palette", {
                detail: { mode: "quickSwitcher" },
              }),
            );
            return;
          case "openShortcutsHelp":
            window.dispatchEvent(new CustomEvent("tessera:open-shortcuts"));
            return;
          case "toggleSidebar":
            window.dispatchEvent(new CustomEvent("tessera:toggle-sidebar"));
            return;
          case "toggleTheme": {
            // Three-state cycle so the toggle is meaningful for users who
            // start on "system" (PR #87.
            //   system -> dark -> light -> system -> ...
            // Users on "system" who pop into "dark" via this shortcut can
            // get back to "system" by toggling once more from "light".
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
            // follow-up: react-router back navigation.
            // We use `navigate(-1)` (not `window.history.back()`) so the
            // router stays in sync with its own history stack — mixing the
            // two stacks would leave the location bar and the rendered
            // page out of phase on fast-back chains.
            navigate(-1);
            return;
          default:
            return;
        }
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [navigate, settings.theme, updateSetting]);
}

/**
 * Re-exported for backwards compatibility with callers that
 * previously imported the hint map from this hook. New code
 * should import directly from `../navigation`.
 */
export { SIDEBAR_SHORTCUT_HINTS } from "../navigation";
