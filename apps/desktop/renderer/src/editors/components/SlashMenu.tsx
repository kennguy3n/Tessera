/**
 * Phase 18 PR 6 — slash-command popup.
 *
 * Renders a positioned list of `SLASH_COMMANDS` filtered by the live
 * query that the `SlashCommandExtension` publishes. Keyboard contract
 * matches the Notion / Linear convention the trigger is modeled after:
 *
 *   - ArrowUp / ArrowDown move the highlight (wrap at the edges).
 *   - Enter / Tab invoke the highlighted command.
 *   - Escape closes the popup without invoking anything.
 *   - All four keys are swallowed (`preventDefault` + `stopPropagation`)
 *     so ProseMirror doesn't also insert a newline / cycle focus.
 *
 * The popup intentionally does NOT manage focus — keeping focus inside
 * the editor lets the user keep typing to refine the query without an
 * intermediate click. Keyboard events are observed via a document-level
 * keydown listener (capture phase, so we beat both the editor and any
 * other handler) and clicks invoke directly.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  filterSlashCommands,
  type SlashCommand,
} from "../documentEditorHelpers";
import type { SlashTriggerState } from "../extensions/SlashCommandExtension";

export interface SlashMenuProps {
  editor: Editor;
  trigger: SlashTriggerState;
  /** Called to dispatch the chosen command. The handler owns the
   *  splice (via `editor.commands.deleteSlashTrigger()`) plus the
   *  block insertion (table, image, task list, …). */
  onSelect: (command: SlashCommand) => void;
  /** Called when the user dismisses without picking (Escape or click
   *  outside). */
  onDismiss: () => void;
}

export function SlashMenu({
  editor,
  trigger,
  onSelect,
  onDismiss,
}: SlashMenuProps) {
  const filtered = useMemo(
    () => filterSlashCommands(trigger.query),
    [trigger.query],
  );
  const [highlight, setHighlight] = useState(0);

  // Clamp the highlight whenever the filtered list shortens (typing
  // narrows the catalog and would otherwise leave the highlight out
  // of bounds).
  useEffect(() => {
    if (highlight >= filtered.length) {
      setHighlight(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [filtered.length, highlight]);

  const select = useCallback(
    (idx: number) => {
      const cmd = filtered[idx];
      if (!cmd) return;
      onSelect(cmd);
    },
    [filtered, onSelect],
  );

  useEffect(() => {
    if (!trigger.visible) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => (filtered.length === 0 ? 0 : (h + 1) % filtered.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) =>
          filtered.length === 0 ? 0 : (h - 1 + filtered.length) % filtered.length,
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (filtered.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        select(highlight);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    }
    // Capture-phase listener so we beat ProseMirror's own keydown
    // handler (which would otherwise insert a newline on Enter).
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [trigger.visible, filtered, highlight, select, onDismiss]);

  // Click-outside dismiss. We bind on the editor's DOM element so a
  // click on the popup itself doesn't bubble out and dismiss.
  useEffect(() => {
    if (!trigger.visible) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node | null;
      // Walk up the DOM looking for our popup root.
      let n: Node | null = target;
      while (n) {
        if ((n as HTMLElement).classList?.contains("slash-menu")) return;
        n = n.parentNode;
      }
      onDismiss();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [trigger.visible, onDismiss]);

  if (!trigger.visible || !trigger.clientRect) return null;

  // Anchor below the trigger character; the editor's container is the
  // positioning context so we use viewport-relative coordinates.
  const style: React.CSSProperties = {
    position: "fixed",
    top: trigger.clientRect.bottom + 4,
    left: trigger.clientRect.left,
    zIndex: 1000,
  };

  // Group by category for visual structure but keep a flat index for
  // keyboard nav.
  const groupedOrder: SlashCommand["category"][] = [
    "blocks",
    "lists",
    "media",
    "inline",
  ];
  const groups: { category: SlashCommand["category"]; items: SlashCommand[] }[] =
    [];
  for (const category of groupedOrder) {
    const items = filtered.filter((c) => c.category === category);
    if (items.length > 0) groups.push({ category, items });
  }

  // Flat index lookup: index of the command in `filtered` (preserves
  // the filterSlashCommands ranking) → highlight.
  let runningIndex = -1;

  return (
    <div
      className="slash-menu"
      role="listbox"
      aria-label="Slash command menu"
      style={style}
      // Keep focus in the editor — let the keydown listener handle nav.
      onMouseDown={(e) => e.preventDefault()}
    >
      {filtered.length === 0 ? (
        <div className="slash-menu-empty">No matching command</div>
      ) : (
        groups.map((group) => (
          <div className="slash-menu-group" key={group.category}>
            <div className="slash-menu-group-label">{group.category}</div>
            {group.items.map((cmd) => {
              const flatIndex = filtered.indexOf(cmd);
              if (flatIndex > runningIndex) runningIndex = flatIndex;
              const active = flatIndex === highlight;
              return (
                <button
                  type="button"
                  key={cmd.id}
                  role="option"
                  aria-selected={active}
                  className={
                    active ? "slash-menu-item slash-menu-item-active" : "slash-menu-item"
                  }
                  onMouseEnter={() => setHighlight(flatIndex)}
                  onClick={() => select(flatIndex)}
                >
                  <div className="slash-menu-item-label">{cmd.label}</div>
                  <div className="slash-menu-item-description">{cmd.description}</div>
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
  // `editor` is intentionally a prop even though we don't read it
  // inside this component — keeps the API symmetric with
  // FindReplacePanel and lets future extensions wire a hover-preview
  // that lifts text from `editor.state` without prop-drilling refactor.
  void editor;
}
