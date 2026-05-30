/**
 * Phase 18 PR 6 — slash-command trigger extension.
 *
 * Detects the user typing `/<query>` at the start of an empty
 * paragraph (the standard Notion / Coda / Linear convention) and
 * notifies a renderer callback so a React popover can show the
 * `SLASH_COMMANDS` catalog filtered by `query`.
 *
 * The extension carries no UI itself — the popover lives in
 * `DocumentEditor.tsx` and is positioned via the callback's
 * `clientRect`. Decoupling means tests can exercise the trigger
 * logic without rendering React.
 *
 * Trigger semantics:
 *   - The user must be at the start of a paragraph (column 0).
 *   - The whole paragraph's text must start with `/`.
 *   - Everything after `/` (up to whitespace) is the query.
 *   - A space after `/` cancels the menu.
 *   - Backspacing past the `/` cancels the menu.
 *   - The trigger only fires inside a regular `paragraph` node —
 *     code blocks, headings, list items, etc. don't open the menu.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface SlashTriggerState {
  /** Empty string when the menu is closed. */
  query: string;
  /**
   * Range of the trigger text in document coordinates, used to splice
   * the trigger away when a command is chosen.
   */
  range: { from: number; to: number } | null;
  /** Viewport rect of the trigger character for popup positioning. */
  clientRect: DOMRect | null;
  /** Whether the menu should be visible. */
  visible: boolean;
}

const PLUGIN_KEY = new PluginKey<SlashTriggerState>("slashCommandTrigger");

const INITIAL: SlashTriggerState = {
  query: "",
  range: null,
  clientRect: null,
  visible: false,
};

export interface SlashCommandOptions {
  /**
   * Called every time the trigger state changes — including open,
   * query update, and close transitions. The renderer pulls
   * positioning + query from the payload.
   */
  onStateChange?: (state: SlashTriggerState) => void;
}

declare module "@tiptap/core" {
  // Expose a command that lets the popup tell the editor to drop the
  // `/<query>` trigger text before inserting whatever block the user
  // picked. Centralising the splice in the extension means the popup
  // doesn't need to track positions itself.
  interface Commands<ReturnType> {
    slashCommand: {
      deleteSlashTrigger: () => ReturnType;
    };
  }
}

export const SlashCommandExtension = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return { onStateChange: undefined };
  },

  addProseMirrorPlugins() {
    const onStateChange = this.options.onStateChange;
    let last: SlashTriggerState = INITIAL;

    function publish(next: SlashTriggerState) {
      if (
        next.visible === last.visible &&
        next.query === last.query &&
        next.range?.from === last.range?.from &&
        next.range?.to === last.range?.to
      ) {
        return;
      }
      last = next;
      onStateChange?.(next);
    }

    return [
      new Plugin<SlashTriggerState>({
        key: PLUGIN_KEY,
        state: {
          init(): SlashTriggerState {
            return INITIAL;
          },
          apply(tr, prev, _oldState, newState): SlashTriggerState {
            const { selection } = newState;
            if (!selection.empty) {
              if (prev.visible) {
                const next = INITIAL;
                publish(next);
                return next;
              }
              return prev;
            }
            const $from = selection.$from;
            const parent = $from.parent;
            // Only fire inside a regular paragraph — code/heading/list
            // items handle `/` literally.
            if (parent.type.name !== "paragraph") {
              if (prev.visible) {
                const next = INITIAL;
                publish(next);
                return next;
              }
              return prev;
            }
            const paragraphText = parent.textContent;
            if (!paragraphText.startsWith("/")) {
              if (prev.visible) {
                const next = INITIAL;
                publish(next);
                return next;
              }
              return prev;
            }
            // Cancel on any whitespace inside the trigger (matches the
            // Notion convention of `/` only firing on one token).
            if (/\s/.test(paragraphText)) {
              if (prev.visible) {
                const next = INITIAL;
                publish(next);
                return next;
              }
              return prev;
            }
            const query = paragraphText.slice(1);
            // The trigger lives at the start of the paragraph.
            // `$from.start()` returns the position immediately after
            // the paragraph's open token, which is where `/` sits.
            const start = $from.start();
            const end = start + paragraphText.length;
            // Defer rect lookup to the EditorView, accessed via the
            // post-transaction view in `viewHandler` below — the
            // plugin state callback runs synchronously and doesn't
            // have view access, so emit with `clientRect: null` here
            // and let the view plugin update it.
            const next: SlashTriggerState = {
              query,
              range: { from: start, to: end },
              clientRect: prev.clientRect,
              visible: true,
            };
            publish(next);
            return next;
          },
        },
        // Capture the actual DOM rect on every paint so the popup
        // can position itself accurately even if the user scrolls
        // or resizes.
        view(view) {
          const update = () => {
            const state = PLUGIN_KEY.getState(view.state);
            if (!state || !state.visible || !state.range) return;
            // `coordsAtPos` walks down to a text node and reads its
            // `getClientRects()`. On jsdom (tests) and in rare
            // headless / SSR contexts the call throws because text
            // nodes don't implement that API. Degrade silently: keep
            // the previously-published `clientRect` (the React popup
            // already handles `null` and just renders detached) so a
            // bad measurement never tears down the editor.
            let dom: { left: number; top: number; bottom: number };
            try {
              dom = view.coordsAtPos(state.range.from);
            } catch {
              return;
            }
            const rect = new DOMRect(
              dom.left,
              dom.top,
              0,
              dom.bottom - dom.top,
            );
            const next: SlashTriggerState = { ...state, clientRect: rect };
            // Suppress publish-loop: only push if rect actually shifted.
            if (
              last.clientRect?.left !== rect.left ||
              last.clientRect?.top !== rect.top
            ) {
              last = next;
              onStateChange?.(next);
            }
          };
          update();
          return {
            update: () => update(),
            destroy: () => {
              if (last.visible) {
                last = INITIAL;
                onStateChange?.(INITIAL);
              }
            },
          };
        },
        // Suppress the default `Enter` / arrow key handling while
        // the popup is visible so the popup can take over those keys.
        // The popup wires its handlers via the editor's `keydown` DOM
        // event in `DocumentEditor.tsx`; this plugin just exposes
        // visibility so the popup knows when to intercept.
      }),
    ];
  },

  addCommands() {
    return {
      deleteSlashTrigger:
        () =>
        ({ tr, dispatch, state }) => {
          const trigger = PLUGIN_KEY.getState(state);
          if (!trigger || !trigger.range) return false;
          if (dispatch) {
            tr.delete(trigger.range.from, trigger.range.to);
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

export { PLUGIN_KEY as SlashCommandPluginKey };
