/**
 * KChat `@mention` TipTap node + trigger (Session 8 Task 2).
 *
 * Typing `@` in the DocumentEditor opens a typeahead that searches
 * KChat users; choosing one inserts a `kchatMention` inline node.
 * The node stores the user's id + username so the document round-
 * trips, and renders as `@username` text in both the editor and the
 * exported HTML (so the share path resolves it to `@username`
 * without any special-casing — see {@link mentionToText}).
 *
 * Like `SlashCommandExtension`, the popup UI lives in
 * `DocumentEditor.tsx`; this extension only detects the trigger and
 * publishes state through `onStateChange`, keeping the trigger
 * logic testable without React.
 */
import { Node, mergeAttributes, type CommandProps } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import {
  MENTION_DATA_TYPE,
  matchMentionQuery,
  mentionToText,
} from "./mentionResolution";

export interface KchatMentionAttrs {
  /** KChat user object id. */
  id: string;
  /** KChat username (without leading `@`). */
  label: string;
}

/** State published to the renderer popup on every trigger change. */
export interface MentionTriggerState {
  /** Text typed after `@` (empty right after the `@`). */
  query: string;
  /** Document range of the `@query` trigger, or null when closed. */
  range: { from: number; to: number } | null;
  /** Viewport rect of the `@` for popup positioning. */
  clientRect: DOMRect | null;
  /** Whether the typeahead popup should be visible. */
  visible: boolean;
}

export interface KchatMentionOptions {
  onStateChange?: (state: MentionTriggerState) => void;
}

const PLUGIN_KEY = new PluginKey<MentionTriggerState>("kchatMentionTrigger");

const INITIAL: MentionTriggerState = {
  query: "",
  range: null,
  clientRect: null,
  visible: false,
};

const DISMISS_META = { dismiss: true } as const;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    kchatMention: {
      /**
       * Replace the active `@query` trigger (or the current
       * selection when no range is supplied) with a mention node
       * for the chosen user, followed by a trailing space.
       */
      insertKchatMention: (attrs: {
        id: string;
        label: string;
        range?: { from: number; to: number };
      }) => ReturnType;
      /** Hide the typeahead without altering the document. */
      dismissKchatMention: () => ReturnType;
    };
  }
}

export const KchatMentionExtension = Node.create<KchatMentionOptions>({
  name: "kchatMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addOptions() {
    return { onStateChange: undefined };
  },

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-id") ?? "",
        renderHTML: (attrs) => ({ "data-id": (attrs as KchatMentionAttrs).id }),
      },
      label: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-label") ?? "",
        renderHTML: (attrs) => ({
          "data-label": (attrs as KchatMentionAttrs).label,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: `span[data-type="${MENTION_DATA_TYPE}"]` }];
  },

  renderHTML({ HTMLAttributes, node }) {
    // Include the `@username` as text content so the exported HTML
    // (and any downstream markdown conversion) carries the resolved
    // mention even without the data attributes.
    const label = (node.attrs as KchatMentionAttrs).label;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-type": MENTION_DATA_TYPE,
        class: "tessera-kchat-mention",
      }),
      mentionToText(label),
    ];
  },

  renderText({ node }) {
    return mentionToText((node.attrs as KchatMentionAttrs).label);
  },

  addCommands() {
    return {
      insertKchatMention:
        (attrs) =>
        ({ chain, state }: CommandProps) => {
          const range = attrs.range ?? {
            from: state.selection.from,
            to: state.selection.to,
          };
          return chain()
            .focus()
            .insertContentAt(range, [
              {
                type: this.name,
                attrs: { id: attrs.id, label: attrs.label },
              },
              { type: "text", text: " " },
            ])
            .run();
        },
      dismissKchatMention:
        () =>
        ({ dispatch, tr }: CommandProps) => {
          if (dispatch) dispatch(tr.setMeta(PLUGIN_KEY, DISMISS_META));
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const onStateChange = this.options.onStateChange;
    let last: MentionTriggerState = INITIAL;

    function publish(next: MentionTriggerState): void {
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
      new Plugin<MentionTriggerState>({
        key: PLUGIN_KEY,
        state: {
          init: () => INITIAL,
          apply(tr, prev, _oldState, newState): MentionTriggerState {
            const close = (): MentionTriggerState => {
              if (prev.visible || prev.range !== null || prev.query !== "") {
                publish(INITIAL);
                return INITIAL;
              }
              return prev;
            };

            const meta = tr.getMeta(PLUGIN_KEY) as
              | { dismiss?: boolean }
              | undefined;
            if (meta?.dismiss) {
              const next = { ...INITIAL };
              // Only republish if something was open.
              if (prev.visible) publish(next);
              return next;
            }

            const { selection } = newState;
            if (!selection.empty) return close();
            const $from = selection.$from;
            if (!$from.parent.isTextblock) return close();

            // Text from the start of the current text block to the
            // caret. `@` triggers anywhere a preceding boundary
            // (block start or whitespace) allows.
            const blockStart = $from.start();
            const textBeforeCaret = $from.parent.textBetween(
              0,
              $from.parentOffset,
              undefined,
              "\ufffc",
            );
            const matched = matchMentionQuery(textBeforeCaret);
            if (!matched) return close();

            const from = blockStart + matched.atOffset;
            const to = $from.pos;
            const next: MentionTriggerState = {
              query: matched.query,
              range: { from, to },
              clientRect: prev.clientRect,
              visible: true,
            };
            publish(next);
            return next;
          },
        },
        view(view) {
          const update = () => {
            const state = PLUGIN_KEY.getState(view.state);
            if (!state || !state.visible || !state.range) return;
            let rect: DOMRect | null = null;
            try {
              const coords = view.coordsAtPos(state.range.from);
              rect = new DOMRect(
                coords.left,
                coords.top,
                0,
                coords.bottom - coords.top,
              );
            } catch {
              // jsdom / headless: keep the last rect; the popup
              // tolerates null.
              rect = state.clientRect;
            }
            if (
              rect &&
              (rect.left !== state.clientRect?.left ||
                rect.top !== state.clientRect?.top)
            ) {
              onStateChange?.({ ...state, clientRect: rect });
            }
          };
          update();
          return { update };
        },
      }),
    ];
  },
});
