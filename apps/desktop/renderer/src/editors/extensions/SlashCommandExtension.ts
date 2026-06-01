/**
 * slash-command trigger extension.
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
 *   - Pressing `Escape` dismisses the menu and — critically — keeps
 *     it dismissed even while the `/<query>` text is still on screen.
 *     The popup is reopened only by clearing the trigger (deleting
 *     the `/`) and re-entering it, matching the Notion / Linear /
 *     Coda convention. See `suppressed` on the plugin state below.
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
  /**
   * Latch set when the user dismisses the menu (Esc / outside-click)
   * while the trigger text is still on screen. While `suppressed` is
   * true, the plugin keeps emitting `visible: false` even if the
   * paragraph still starts with `/<query>`. The latch is cleared the
   * moment the trigger conditions are no longer met (the `/` is
   * deleted, the selection leaves the paragraph, a space is typed,
   * etc.) so the very next `/` opens the menu fresh. This is the
   * Notion / Linear / Coda convention and matches what Devin Review
   * PR #80 round 2 (ANALYSIS_…_0001) flagged as broken — prior to
   * this, dismissing only cleared React state and the plugin's
   * unchanged `apply` republished `visible: true` on the very next
   * keystroke.
   *
   * Not part of the public popup contract — React just reads
   * `visible` — but exposed on the state so `apply` can decide
   * what to publish without external bookkeeping.
   */
  suppressed: boolean;
}

/** Meta dispatched by the `dismissSlashMenu` command. */
const DISMISS_META = { dismiss: true } as const;

const PLUGIN_KEY = new PluginKey<SlashTriggerState>("slashCommandTrigger");

const INITIAL: SlashTriggerState = {
  query: "",
  range: null,
  clientRect: null,
  visible: false,
  suppressed: false,
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
  // doesn't need to track positions itself. `dismissSlashMenu` is the
  // Escape / outside-click counterpart — see the `suppressed` field
  // on `SlashTriggerState` for why it has to flow through the plugin
  // and not just React state.
  interface Commands<ReturnType> {
    slashCommand: {
      deleteSlashTrigger: () => ReturnType;
      dismissSlashMenu: () => ReturnType;
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
            // Helper: emit a closed state, clearing the suppression
            // latch as well. Used whenever the trigger conditions
            // genuinely no longer hold (selection moved, paragraph
            // emptied, space typed, etc.) so the NEXT valid trigger
            // opens the menu fresh.
            const closeAndReset = (): SlashTriggerState => {
              if (
                prev.visible ||
                prev.suppressed ||
                prev.range !== null ||
                prev.query !== ""
              ) {
                publish(INITIAL);
                return INITIAL;
              }
              return prev;
            };

            // The popup tells us "user pressed Esc / clicked away"
            // via this meta. We latch `suppressed = true` and hide
            // the menu but keep the `/<query>` text intact — the
            // user typed it intentionally and we should not destroy
            // their characters just because they dismissed the
            // dropdown. Without this latch the plugin's next `apply`
            // would happily republish `visible: true` because the
            // paragraph still starts with `/`. Devin Review PR #80
            // round 2 (ANALYSIS_…_0001) flagged the bounce-back.
            const meta = tr.getMeta(PLUGIN_KEY) as
              | { dismiss?: boolean }
              | undefined;
            if (meta?.dismiss) {
              const next: SlashTriggerState = {
                ...prev,
                visible: false,
                suppressed: true,
              };
              publish(next);
              return next;
            }

            const { selection } = newState;
            if (!selection.empty) return closeAndReset();
            const $from = selection.$from;
            const parent = $from.parent;
            // Only fire inside a regular paragraph — code/heading/list
            // items handle `/` literally.
            if (parent.type.name !== "paragraph") return closeAndReset();
            const paragraphText = parent.textContent;
            if (!paragraphText.startsWith("/")) return closeAndReset();
            // Cancel on any whitespace inside the trigger (matches the
            // Notion convention of `/` only firing on one token).
            if (/\s/.test(paragraphText)) return closeAndReset();
            // Trigger conditions DO hold. If the menu was dismissed
            // mid-trigger (suppressed latch) we honour the user's
            // intent and stay closed until the trigger text is
            // cleared. We still keep `suppressed: true` on the
            // returned state so the popup stays hidden through every
            // subsequent keystroke that extends the query.
            if (prev.suppressed) {
              // Nothing observable changed for the React panel
              // (`visible: false` already published), so do NOT
              // re-publish — publish() would be a no-op anyway, but
              // we also don't want to overwrite the popup's last
              // rect with a stale measurement.
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
              suppressed: false,
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
      // Latch the suppression flag so the menu stays closed until
      // the user clears + re-enters the `/` trigger. The plugin
      // state owner is the source of truth for visibility — React
      // setting its local `slashTrigger` to closed isn't sufficient
      // because the plugin will republish `visible: true` on the
      // next keystroke.
      dismissSlashMenu:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(PLUGIN_KEY, DISMISS_META);
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

export { PLUGIN_KEY as SlashCommandPluginKey };
