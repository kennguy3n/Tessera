/**
 * reusable right-click context menu component.
 *
 * Pair this with the `useContextMenu` hook (in
 * `hooks/useContextMenu.ts`): the hook owns open/close state and
 * gives you a ready-to-spread `onContextMenu` handler; this
 * component renders the menu chrome, handles keyboard
 * navigation (ArrowUp/Down/Enter/Escape), and dismisses on
 * outside click.
 *
 * Kept in a `.tsx` file that only exports components (no shared
 * hook) so Vite's fast-refresh boundary stays clean.
 */

import {
  type CSSProperties,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCspNonce } from "../utils/cspNonce";

export interface ContextMenuItem {
  /** Stable id used as the React key. */
  id: string;
  /** Visible label. */
  label: string;
  /**
   * Action invoked when the user selects this item. The menu
   * closes before invoking, so the handler can safely open
   * modals / navigate without racing the menu close.
   */
  onSelect: () => void;
  /**
   * When true, the item is rendered greyed-out and not selectable.
   */
  disabled?: boolean;
  /**
   * When true, the item is visually styled as destructive (red
   * tint). Used for Delete actions.
   */
  destructive?: boolean;
  /** When true, this item is rendered as a divider above. */
  separatorAbove?: boolean;
}

interface ContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number } | null;
  items: ReadonlyArray<ContextMenuItem>;
  onClose: () => void;
}

export default function ContextMenu({
  isOpen,
  position,
  items,
  onClose,
}: ContextMenuProps) {
  const cspNonce = useCspNonce();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // PR #87: don't initialise activeIndex
  // to 0 unconditionally — that lands the keyboard focus ring on a
  // disabled first item (e.g. an "Open" entry that is disabled
  // when the artifact is already open in the current tab), which
  // is visually misleading AND requires the user to press
  // ArrowDown an extra time before Enter does anything. Find the
  // first enabled item instead.
  useEffect(() => {
    if (!isOpen) return;
    const firstEnabled = items.findIndex((item) => !item.disabled);
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
  }, [isOpen, items]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => {
          for (let n = 1; n <= items.length; n++) {
            const candidate = (i + n) % items.length;
            if (!items[candidate]?.disabled) return candidate;
          }
          return i;
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => {
          for (let n = 1; n <= items.length; n++) {
            const candidate = (i - n + items.length) % items.length;
            if (!items[candidate]?.disabled) return candidate;
          }
          return i;
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const item = items[activeIndex];
        if (item && !item.disabled) {
          onClose();
          item.onSelect();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, items, activeIndex, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const outsideClick = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) onClose();
    };
    // Defer to next tick so the same click that *opened* the menu
    // (i.e. the contextmenu event) does not immediately close it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", outsideClick);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", outsideClick);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !position) return null;

  // Clamp position to viewport so the menu never opens off-screen.
  const style: CSSProperties = {
    left: Math.max(
      4,
      Math.min(position.x, (typeof window !== "undefined" ? window.innerWidth : 1024) - 220),
    ),
    top: Math.max(
      4,
      Math.min(position.y, (typeof window !== "undefined" ? window.innerHeight : 768) - 220),
    ),
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label="Context menu"
      style={style}
      data-testid="context-menu"
    >
      <ul className="context-menu-list">
        {items.map((item, i) => (
          <li key={item.id} className="context-menu-li">
            {item.separatorAbove && (
              <hr className="context-menu-sep" aria-hidden="true" />
            )}
            <button
              type="button"
              role="menuitem"
              className={[
                "context-menu-item",
                i === activeIndex ? "context-menu-item-active" : "",
                item.destructive ? "context-menu-item-destructive" : "",
                item.disabled ? "context-menu-item-disabled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              disabled={item.disabled}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
      <style nonce={cspNonce}>{`
        .context-menu {
          position: fixed;
          z-index: 1100;
          min-width: 200px;
          background: var(--color-bg-elevated);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          box-shadow: var(--shadow-lg);
          padding: var(--spacing-xs) 0;
          transform-origin: top left;
          animation: context-menu-in var(--duration-fast) var(--ease-out);
        }
        .context-menu-list {
          list-style: none;
          margin: 0;
          padding: 0;
        }
        .context-menu-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: var(--spacing-xs) var(--spacing-md);
          background: transparent;
          border: none;
          color: var(--color-text-body);
          font-size: var(--font-size-sm);
          cursor: pointer;
          transition: background-color var(--transition-fast),
            color var(--transition-fast);
        }
        .context-menu-item:hover,
        .context-menu-item-active {
          background: var(--color-primary-light);
        }
        .context-menu-item:focus-visible {
          outline: none;
          box-shadow: var(--focus-ring-inset);
        }
        .context-menu-item-destructive {
          color: var(--color-danger, #d4380d);
        }
        .context-menu-item-destructive:hover,
        .context-menu-item-destructive.context-menu-item-active {
          background: var(--color-danger-subtle);
        }
        .context-menu-item-disabled {
          color: var(--color-text-tertiary, var(--color-text-secondary));
          cursor: default;
        }
        .context-menu-item-disabled:hover,
        .context-menu-item-disabled.context-menu-item-active {
          background: transparent;
        }
        .context-menu-sep {
          border: none;
          border-top: 1px solid var(--color-border);
          margin: var(--spacing-xs) 0;
        }
        @keyframes context-menu-in {
          from {
            opacity: 0;
            transform: scale(0.96) translateY(-2px);
          }
          to {
            opacity: 1;
            transform: scale(1) translateY(0);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .context-menu {
            animation: none;
          }
          .context-menu-item {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}
