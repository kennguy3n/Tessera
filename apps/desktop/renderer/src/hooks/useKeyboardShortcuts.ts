import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Tessera's global keyboard shortcuts (Task 16).
 *
 * Registered once at the app root by `App.tsx`. Each shortcut is
 * implemented as a single keydown handler that consults
 * `e.metaKey || e.ctrlKey` so both macOS (Cmd) and Linux/Windows
 * (Ctrl) work. We intentionally skip shortcuts when the user is
 * typing inside a textbox / contenteditable so we don't shadow
 * native browser shortcuts like Ctrl+A inside an editor — except
 * Escape and `Ctrl/Cmd+S`, which we still capture so users can
 * force-save from the editor and dismiss modals from anywhere.
 *
 * The 1–7 sidebar shortcuts map directly to the sidebar items in
 * `Sidebar.tsx`:
 *
 *   1: Home, 2: Sources, 3: Templates, 4: Create,
 *   5: Tasks, 6: Automations, 7: Settings
 */

const SIDEBAR_NAV: Record<string, string> = {
  "1": "/",
  "2": "/sources",
  "3": "/templates",
  "4": "/create",
  "5": "/tasks",
  "6": "/automations",
  "7": "/settings",
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Escape: close modals / dialogs. The Modal component owns
      // its own document-level handler, so here we only emit a
      // global "tessera:escape" event so any other consumer (e.g.
      // search bar, command palette) can hook in.
      if (e.key === "Escape" && !mod) {
        window.dispatchEvent(new CustomEvent("tessera:escape"));
        return;
      }

      if (!mod) return;

      // Allow Ctrl/Cmd+S to fire from anywhere — including editor
      // textareas — so users can force-save. Same for E (export).
      switch (e.key.toLowerCase()) {
        case "n":
          if (isTypingTarget(e.target)) return;
          e.preventDefault();
          navigate("/create");
          return;
        case "s":
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("tessera:save"));
          return;
        case "e":
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("tessera:export"));
          return;
        case "f":
          if (isTypingTarget(e.target)) return;
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("tessera:focus-search"));
          return;
        case ",":
          if (isTypingTarget(e.target)) return;
          e.preventDefault();
          navigate("/settings");
          return;
        default:
          break;
      }

      // Sidebar Ctrl/Cmd+1..7
      if (SIDEBAR_NAV[e.key]) {
        if (isTypingTarget(e.target)) return;
        e.preventDefault();
        navigate(SIDEBAR_NAV[e.key]);
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [navigate]);
}

/**
 * Static description used by the Sidebar to render shortcut hints.
 * Exported so tests can assert the map without re-deriving it.
 */
export const SIDEBAR_SHORTCUT_HINTS: Record<string, string> = {
  "/": "1",
  "/sources": "2",
  "/templates": "3",
  "/create": "4",
  "/tasks": "5",
  "/automations": "6",
  "/settings": "7",
};
