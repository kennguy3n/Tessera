/**
 * Phase 18 Task 19: keyboard-shortcuts cheatsheet modal.
 *
 * Renders every entry in `COMMAND_REGISTRY` that has a chord,
 * grouped by category. The list is generated from the same
 * registry that drives the Cmd+K palette and the runner, so a new
 * shortcut added to the registry shows up here automatically
 * without a separate doc update.
 *
 * Triggered by Cmd+/ (registered in `useKeyboardShortcuts`) or
 * via the Cmd+K palette's "Show keyboard shortcuts" command.
 */

import { useMemo } from "react";
import Modal from "./Modal";
import { useCspNonce } from "../utils/cspNonce";
import {
  type Command,
  COMMAND_CATEGORIES,
  COMMAND_REGISTRY,
  formatChord,
  groupCommandsByCategory,
} from "../utils/commandRegistry";

interface KeyboardShortcutsHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function KeyboardShortcutsHelp({
  isOpen,
  onClose,
}: KeyboardShortcutsHelpProps) {
  const cspNonce = useCspNonce();
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform);

  const grouped = useMemo(() => {
    const withChord = COMMAND_REGISTRY.filter(
      (c): c is Command & { chord: NonNullable<Command["chord"]> } =>
        c.chord !== null,
    );
    return groupCommandsByCategory(withChord);
  }, []);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard shortcuts">
      <div className="shortcuts-help">
        {COMMAND_CATEGORIES.map((category) => {
          const entries = grouped[category];
          if (entries.length === 0) return null;
          return (
            <section key={category} className="shortcuts-section">
              <h3 className="shortcuts-section-title">{category}</h3>
              <ul className="shortcuts-list">
                {entries.map((cmd) => (
                  <li key={cmd.id} className="shortcuts-row">
                    <div className="shortcuts-row-text">
                      <div className="shortcuts-row-title">{cmd.title}</div>
                      <div className="shortcuts-row-sub">
                        {cmd.description}
                      </div>
                    </div>
                    <kbd className="shortcuts-kbd">
                      {cmd.chord ? formatChord(cmd.chord, isMac) : ""}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <style nonce={cspNonce}>{`
        .shortcuts-help {
          max-height: 60vh;
          overflow-y: auto;
          padding-right: var(--spacing-sm);
        }
        .shortcuts-section {
          margin-bottom: var(--spacing-lg);
        }
        .shortcuts-section-title {
          font-size: var(--font-size-sm);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--color-text-secondary);
          margin: 0 0 var(--spacing-xs);
        }
        .shortcuts-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .shortcuts-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-md);
          padding: var(--spacing-xs) 0;
          border-bottom: 1px solid var(--color-border-light, var(--color-border));
        }
        .shortcuts-row:last-child {
          border-bottom: none;
        }
        .shortcuts-row-text {
          flex: 1;
          min-width: 0;
        }
        .shortcuts-row-title {
          color: var(--color-text-body);
          font-weight: var(--font-weight-medium);
        }
        .shortcuts-row-sub {
          color: var(--color-text-secondary);
          font-size: var(--font-size-xs);
        }
        .shortcuts-kbd {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: var(--font-size-xs);
          background: var(--color-bg-secondary, transparent);
          padding: 4px 8px;
          border-radius: 4px;
          flex-shrink: 0;
          color: var(--color-text-body);
        }
      `}</style>
    </Modal>
  );
}
