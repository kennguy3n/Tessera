/**
 * KChat `@mention` typeahead popup (Session 8 Task 2).
 *
 * Renders a positioned list of KChat users matching the live query
 * the `KchatMentionExtension` publishes. The keyboard contract
 * mirrors {@link SlashMenu}:
 *
 *   - ArrowUp / ArrowDown move the highlight (wrap at the edges).
 *   - Enter / Tab insert the highlighted user as a mention node.
 *   - Escape closes the popup without inserting anything.
 *   - All keys are swallowed (`preventDefault` + `stopPropagation`)
 *     so ProseMirror doesn't also handle them.
 *
 * Unlike the slash menu (whose catalog is static), the candidate
 * list is fetched from the main process via
 * `kchat.searchUsers(query)`. The fetch is debounced and guarded by
 * a request-sequence ref so a slow earlier response can't clobber a
 * newer one. Like the slash menu, the popup keeps focus in the
 * editor so the user can keep typing to refine the query.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MentionTriggerState } from "../extensions/KchatMentionExtension";
import type { KchatUserSearchResultView } from "../../types/ipc";

export interface MentionMenuProps {
  trigger: MentionTriggerState;
  /** Insert the chosen user as a mention node. Owns the splice. */
  onSelect: (user: KchatUserSearchResultView) => void;
  /** Dismiss without inserting (Escape or click outside). */
  onDismiss: () => void;
}

/** Debounce (ms) before issuing a user-search request. */
const SEARCH_DEBOUNCE_MS = 150;

function getApi() {
  return typeof window !== "undefined" ? window.tessera : undefined;
}

export function MentionMenu({
  trigger,
  onSelect,
  onDismiss,
}: MentionMenuProps) {
  const [users, setUsers] = useState<KchatUserSearchResultView[]>([]);
  const [highlight, setHighlight] = useState(0);
  // Monotonic request id so a slow earlier search can't overwrite a
  // newer one's results.
  const seqRef = useRef(0);

  // Debounced user search on every query change.
  useEffect(() => {
    if (!trigger.visible) return;
    const api = getApi();
    if (!api?.kchat || typeof api.kchat.searchUsers !== "function") {
      setUsers([]);
      return;
    }
    const seq = ++seqRef.current;
    const query = trigger.query;
    const timer = setTimeout(() => {
      void api.kchat
        .searchUsers(query, 8)
        .then((results) => {
          // Ignore stale responses.
          if (seq !== seqRef.current) return;
          setUsers(results);
          setHighlight(0);
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setUsers([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trigger.visible, trigger.query]);

  // Clamp the highlight whenever the list shortens.
  useEffect(() => {
    if (highlight >= users.length) {
      setHighlight(users.length === 0 ? 0 : users.length - 1);
    }
  }, [users.length, highlight]);

  const select = useCallback(
    (idx: number) => {
      const user = users[idx];
      if (!user) return;
      onSelect(user);
    },
    [users, onSelect],
  );

  useEffect(() => {
    if (!trigger.visible) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) => (users.length === 0 ? 0 : (h + 1) % users.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setHighlight((h) =>
          users.length === 0 ? 0 : (h - 1 + users.length) % users.length,
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (users.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        select(highlight);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    }
    // Capture phase so we beat ProseMirror's own keydown handler.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [trigger.visible, users, highlight, select, onDismiss]);

  // Click-outside dismiss.
  useEffect(() => {
    if (!trigger.visible) return;
    function onPointerDown(e: PointerEvent) {
      let n: Node | null = e.target as Node | null;
      while (n) {
        if ((n as HTMLElement).classList?.contains("mention-menu")) return;
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

  const style: React.CSSProperties = {
    position: "fixed",
    top: trigger.clientRect.bottom + 4,
    left: trigger.clientRect.left,
    zIndex: 1000,
  };

  return (
    <div
      className="mention-menu"
      role="listbox"
      aria-label="KChat mention menu"
      style={style}
      onMouseDown={(e) => e.preventDefault()}
    >
      {users.length === 0 ? (
        <div className="mention-menu-empty">No matching users</div>
      ) : (
        users.map((user, idx) => {
          const active = idx === highlight;
          return (
            <button
              type="button"
              key={user.id}
              role="option"
              aria-selected={active}
              className={
                active
                  ? "mention-menu-item mention-menu-item-active"
                  : "mention-menu-item"
              }
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => select(idx)}
            >
              <span className="mention-menu-item-username">
                @{user.username}
              </span>
              {user.displayName && user.displayName !== user.username ? (
                <span className="mention-menu-item-name">
                  {user.displayName}
                </span>
              ) : null}
            </button>
          );
        })
      )}
    </div>
  );
}
