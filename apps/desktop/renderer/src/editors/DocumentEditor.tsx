import {
  useEffect,
  useCallback,
  useRef,
  useState,
  useMemo,
  type ChangeEvent,
} from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import {
  Sparkles,
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Underline as UnderlineIcon,
  Highlighter,
  Baseline,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignJustify,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Code2,
  Link as LinkIcon,
  Table as TableIcon,
  Image as ImageIcon,
  Minus,
  Workflow,
  Search,
  MessageSquarePlus,
  MessageSquare,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Heading,
  TableCellsMerge,
  Trash2,
} from "lucide-react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
// `@tiptap/extension-table` is the umbrella package — it re-exports every
// table primitive as a named export but does NOT ship a default export
// (unlike its sibling `extension-table-row` / `-header` / `-cell`,
// which all re-export `<Class> as default` from this very package).
// Use the named import to stay correct against the published .d.ts.
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import CharacterCount from "@tiptap/extension-character-count";
import Image from "@tiptap/extension-image";
import HorizontalRule from "@tiptap/extension-horizontal-rule";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
// `@tiptap/extension-text-style` is the umbrella mark package: TextStyle is
// the base inline mark, and Color / FontFamily / FontSize are thin extensions
// that write their attribute onto it. All first-party and tree-shakeable — no
// new vendor. (Line height is block-level, so it comes from BlockLineHeight
// below rather than this mark-oriented package.)
//
// The stock Color/FontFamily/FontSize/Highlight extensions interpolate their
// stored value straight into an inline `style`, so we swap in sanitised
// variants (see `extensions/safeTypography`) that allow-list the value before
// it is serialised — a crafted document cannot inject extra CSS declarations.
import { TextStyle } from "@tiptap/extension-text-style";
import {
  SafeColor,
  SafeFontFamily,
  SafeFontSize,
  SafeHighlight,
} from "./extensions/safeTypography";
import TextAlign from "@tiptap/extension-text-align";
import { common, createLowlight } from "lowlight";
import { MermaidNode } from "./extensions/MermaidExtension";
import { CalloutNode } from "./extensions/CalloutExtension";
import { ToggleNode } from "./extensions/ToggleExtension";
import { BlockLineHeight } from "./extensions/BlockLineHeight";
import { TableOfContentsNode } from "./extensions/TableOfContentsExtension";
import {
  FindReplaceExtension,
} from "./extensions/FindReplaceExtension";
import {
  SlashCommandExtension,
  type SlashTriggerState,
} from "./extensions/SlashCommandExtension";
import {
  KchatMentionExtension,
  type MentionTriggerState,
} from "./extensions/KchatMentionExtension";
import {
  CommentMark,
  collectCommentsFromDoc,
} from "./extensions/CommentMark";
import {
  parseDocumentContent,
  countDocText,
  customTypographyValue,
  fileToDataUrl,
  type SlashCommand,
} from "./documentEditorHelpers";
import {
  DEFAULT_COMMENT_AUTHOR,
  countOpenComments,
  makeCommentId,
  normalizeCommentText,
  type DocumentComment,
} from "./documentCommentsHelpers";
import { FindReplacePanel } from "./components/FindReplacePanel";
import { CommentsPanel } from "./components/CommentsPanel";
import { SlashMenu } from "./components/SlashMenu";
import { MentionMenu } from "./components/MentionMenu";
import {
  AiAssistantPanel,
  type AiAssistantContext,
} from "./components/AiAssistantPanel";
import { LinkPopover } from "./components/LinkPopover";
import { captureAiContext } from "./ai/documentAiApply";
import type { DocumentAiActionId } from "./ai/documentAiTypes";
import {
  collectHeadings,
  formatReadingTime,
  pickActiveHeadingIndex,
  type HeadingEntry,
} from "./documentOutlineHelpers";
import type { KchatUserSearchResultView } from "../types/ipc";

interface DocumentEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
}

// Lowlight bundle shared across editor instances. `common` ships the
// 35 languages every documentation site needs (js/ts/python/rust/go/…)
// without dragging in the full ~190-language bundle that doubles the
// renderer's bytes-shipped.
const lowlight = createLowlight(common);

const SLASH_TRIGGER_INITIAL: SlashTriggerState = {
  query: "",
  range: null,
  clientRect: null,
  visible: false,
  suppressed: false,
};

const MENTION_TRIGGER_INITIAL: MentionTriggerState = {
  query: "",
  range: null,
  clientRect: null,
  visible: false,
};

// Curated typography options. Font families ship real CSS stacks (with web-safe
// fallbacks) so the chosen face renders the same on export as in the editor; an
// empty value means "unset" (fall back to the document's base style).
const FONT_FAMILY_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Default", value: "" },
  { label: "Sans serif", value: "Inter, system-ui, sans-serif" },
  { label: "Serif", value: "Georgia, 'Times New Roman', serif" },
  { label: "Monospace", value: "'JetBrains Mono', 'Courier New', monospace" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
];

const FONT_SIZE_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Default", value: "" },
  { label: "12", value: "12px" },
  { label: "14", value: "14px" },
  { label: "16", value: "16px" },
  { label: "18", value: "18px" },
  { label: "20", value: "20px" },
  { label: "24", value: "24px" },
  { label: "30", value: "30px" },
  { label: "36", value: "36px" },
];

const LINE_HEIGHT_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Default", value: "" },
  { label: "1.0", value: "1" },
  { label: "1.15", value: "1.15" },
  { label: "1.5", value: "1.5" },
  { label: "2.0", value: "2" },
];

// Sensible starting swatch for the native colour picker when the selection has
// no explicit colour yet (the picker can't represent "inherit").
const DEFAULT_TEXT_COLOR = "#111827";
const DEFAULT_HIGHLIGHT_COLOR = "#fde68a";

const TEXT_ALIGNMENTS = [
  ["left", AlignLeft, "Align left"],
  ["center", AlignCenter, "Align center"],
  ["right", AlignRight, "Align right"],
  ["justify", AlignJustify, "Justify"],
] as const;

export default function DocumentEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
}: DocumentEditorProps) {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Initialize to empty string; updated to editor's parsed HTML in onCreate
  const lastSavedRef = useRef("");
  // Ref-wrap onDraftChange AND onSave so the TipTap `onUpdate` closure
  // (created once at mount) always calls the latest callback without
  // recreating the editor. Both props can change identity when the parent
  // re-renders (e.g. when the artifact `id` route param changes and
  // `ArtifactEditorPage` rebuilds its `handleSave` via `useCallback`).
  // Without the ref the closure here would keep calling whatever
  // `onSave` was at mount time — fine today because we tear the whole
  // editor down on `id` change, but a foot-gun for future maintainers.
  const onDraftChangeRef = useRef(onDraftChange);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange;
  }, [onDraftChange]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  // Find/replace panel visibility — toggled by Ctrl+F and the toolbar.
  const [findOpen, setFindOpen] = useState(false);

  // Comments side-panel visibility — toggled by the toolbar.
  const [commentsOpen, setCommentsOpen] = useState(false);

  // AI assistant panel. `null` = closed; when open it carries a
  // snapshot of the selection captured at open time + the action to
  // preselect. Snapshotting (rather than reading live selection) keeps
  // the panel stable once focus moves into its own inputs.
  const [aiState, setAiState] = useState<{
    context: AiAssistantContext;
    action?: DocumentAiActionId;
  } | null>(null);

  // Link editor popover. `null` = closed.
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);

  // Bumped on every TipTap `onUpdate` so memos that derive from the
  // editor's plain-text content (e.g. word count, outline headings)
  // recompute when the doc changes. Naïvely depending on
  // `editor.state.doc` works at runtime — TipTap re-renders this
  // component on every dispatch — but the React-Hooks lint rule
  // can't see through `editor` to that property and flags it as
  // accessing a value that won't trigger re-renders. A small
  // monotonic counter is both correct AND lint-clean.
  const [docVersion, setDocVersion] = useState(0);

  // Slash-trigger state, populated by the extension's `onStateChange`.
  const [slashTrigger, setSlashTrigger] = useState<SlashTriggerState>(
    SLASH_TRIGGER_INITIAL,
  );

  // KChat @mention trigger state, populated by the extension's
  // `onStateChange` (Session 8 Task 2).
  const [mentionTrigger, setMentionTrigger] = useState<MentionTriggerState>(
    MENTION_TRIGGER_INITIAL,
  );

  // File-picker ref for the toolbar's image upload button. We keep
  // the underlying `<input type=file>` in the DOM but visually hidden
  // so screen readers can still surface it.
  const imageInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    // Defer the first render until after mount. Without this, React
    // StrictMode's mount→unmount→remount probe destroys the editor
    // created during the throwaway mount, and the effects below then
    // run `setContent` / read `view.dom` against a destroyed instance
    // (TypeError: reading 'commands' / 'view' of null). Deferring the
    // initial render keeps the editor instance valid across the probe.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // We replace StarterKit's basic codeBlock with the lowlight-
        // backed variant below so syntax highlighting fires on
        // every code block (including ones pasted from clipboard).
        codeBlock: false,
        // Keep StarterKit's HorizontalRule for the basic case; we
        // configure the standalone one separately so the slash menu
        // can call `setHorizontalRule()` without ambiguity.
        horizontalRule: false,
        // StarterKit v3 bundles Link (with openOnClick: true). We register
        // our own Link.configure({ openOnClick: false, autolink: true })
        // below, so disable StarterKit's copy to avoid a duplicate
        // registration whose defaults would otherwise shadow ours.
        link: false,
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: "plaintext",
      }),
      // Inline typography. TextStyle must precede the extensions that write
      // onto it. FontSize/Color/FontFamily stay inline (default `textStyle`
      // target). Line height and alignment are block-level attributes set on
      // whole paragraphs/headings via updateAttributes (BlockLineHeight /
      // TextAlign), not on the inline mark.
      TextStyle,
      SafeColor,
      SafeFontFamily,
      SafeFontSize,
      BlockLineHeight.configure({ types: ["paragraph", "heading"] }),
      SafeHighlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      HorizontalRule,
      Placeholder.configure({
        placeholder: "Start writing your document...",
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      CharacterCount,
      Image.configure({ inline: false, allowBase64: true }),
      MermaidNode,
      CalloutNode,
      ToggleNode,
      TableOfContentsNode,
      FindReplaceExtension,
      CommentMark,
      SlashCommandExtension.configure({
        onStateChange: (state) => setSlashTrigger(state),
      }),
      KchatMentionExtension.configure({
        onStateChange: (state) => setMentionTrigger(state),
      }),
    ],
    // TipTap renders the editable surface as a `role="textbox"` region;
    // without a name it trips `aria-input-field-name`. Give the body a
    // stable accessible name so screen readers announce what the
    // contenteditable is for. (The visible page/editor header is a
    // separate element, so an explicit `aria-label` is the reliable
    // name source here.)
    editorProps: {
      attributes: {
        "aria-label": "Document body",
      },
    },
    content: parseDocumentContent(content),
    onCreate: ({ editor }) => {
      // Sync lastSavedRef to the editor's parsed HTML so the first real
      // user edit doesn't trigger a spurious save.
      lastSavedRef.current = editor.getHTML();
    },
    onUpdate: ({ editor }) => {
      // Bump the doc-version counter so derived memos recompute. We
      // bump even when the HTML round-trips to the last-saved value
      // (e.g. user typed then immediately undid) so transient outline
      // / word-count changes still reflect.
      setDocVersion((v) => v + 1);
      const html = editor.getHTML();
      if (html === lastSavedRef.current) return;

      // Publish the draft immediately (no debounce) so exporting before the
      // 2s auto-save fires still captures the live editor state.
      onDraftChangeRef.current?.(html);

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        lastSavedRef.current = html;
        onSaveRef.current(html);
      }, autoSaveMs);
    },
  });

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Guard against a destroyed editor: under StrictMode the effect can
    // fire after TipTap has torn down the instance from the probe mount.
    if (!editor || editor.isDestroyed) return;
    const parsed = parseDocumentContent(content);
    // Only update editor if content came from an external source (not our own save)
    if (parsed !== lastSavedRef.current) {
      editor.commands.setContent(parsed);
      lastSavedRef.current = editor.getHTML();
    }
  }, [content, editor]);

  // Ctrl/Cmd+F opens the find panel. We bind on the editor's wrapping
  // div so the binding only fires when the editor has focus — global
  // capture would steal the browser's own Ctrl+F when the user is on
  // a different panel.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const dom = editor.view.dom as HTMLElement;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
        // Open the on-device AI assistant against the current selection.
        e.preventDefault();
        setLinkPopoverOpen(false);
        setAiState({ context: captureAiContext(editor), action: undefined });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        // Add / edit a link on the current selection.
        e.preventDefault();
        setAiState(null);
        setLinkPopoverOpen(true);
      }
    };
    dom.addEventListener("keydown", onKeyDown);
    return () => {
      dom.removeEventListener("keydown", onKeyDown);
    };
  }, [editor]);

  // Open the AI assistant against a snapshot of the current selection.
  // `action` lets a caller (slash `/ai`, selection toolbar) preselect
  // the writing action; omit it to let the panel choose based on
  // whether there's a selection.
  const openAi = useCallback(
    (action?: DocumentAiActionId) => {
      if (!editor) return;
      // Only one floating panel at a time: opening AI dismisses the link popover.
      setLinkPopoverOpen(false);
      setAiState({ context: captureAiContext(editor), action });
    },
    [editor],
  );

  // Open the link popover. Replaces the old `window.prompt` flow with a
  // proper editable popover (add / edit / visit / remove) anchored to
  // the editor.
  const openLinkPopover = useCallback(() => {
    if (!editor) return;
    // Only one floating panel at a time: opening the link popover dismisses AI.
    setAiState(null);
    setLinkPopoverOpen(true);
  }, [editor]);

  // Common splice for slash-menu activation: drop the `/<query>`
  // text, then dispatch the chosen block insert. Centralised here so
  // every command runs through the same cleanup.
  const dispatchSlash = useCallback(
    (cmd: SlashCommand) => {
      if (!editor) return;
      // `/ai` is special: drop the trigger text, then open the AI
      // assistant panel rather than inserting a block.
      if (cmd.id === "ai") {
        editor.chain().focus().deleteSlashTrigger().run();
        setSlashTrigger(SLASH_TRIGGER_INITIAL);
        openAi("custom");
        return;
      }
      const chain = editor.chain().focus().deleteSlashTrigger();
      switch (cmd.id) {
        case "heading-1":
          chain.setNode("heading", { level: 1 }).run();
          break;
        case "heading-2":
          chain.setNode("heading", { level: 2 }).run();
          break;
        case "heading-3":
          chain.setNode("heading", { level: 3 }).run();
          break;
        case "paragraph":
          chain.setNode("paragraph").run();
          break;
        case "blockquote":
          chain.toggleBlockquote().run();
          break;
        case "code-block":
          chain.toggleCodeBlock().run();
          break;
        case "horizontal-rule":
          chain.setHorizontalRule().run();
          break;
        case "bullet-list":
          chain.toggleBulletList().run();
          break;
        case "ordered-list":
          chain.toggleOrderedList().run();
          break;
        case "task-list":
          chain.toggleTaskList().run();
          break;
        case "table":
          chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
          break;
        case "image":
          chain.run();
          imageInputRef.current?.click();
          break;
        case "mermaid":
          chain.insertMermaid().run();
          break;
        case "callout":
          chain.toggleCallout().run();
          break;
        case "toggle":
          chain.insertToggle().run();
          break;
        case "table-of-contents":
          chain.insertTableOfContents().run();
          break;
        default:
          chain.run();
          break;
      }
      setSlashTrigger(SLASH_TRIGGER_INITIAL);
    },
    [editor, openAi],
  );

  const dismissSlash = useCallback(() => {
    // Latch suppression on the PM plugin so the menu stays closed
    // until the user clears + re-enters the `/` trigger. Just clearing
    // React state here would let the plugin republish `visible: true`
    // on the very next keystroke (the paragraph still starts with
    // `/`) and the menu would bounce back — the bug Devin Review PR
    // #80 round 2 (ANALYSIS_…_0001) flagged. The plugin's
    // onStateChange will then push `visible: false` back through to
    // `setSlashTrigger`, so the React state stays in sync without us
    // having to set it directly here. We still touch React state
    // synchronously as belt-and-braces so the popup unmounts in the
    // SAME frame as the Esc keystroke (in case the editor command
    // dispatch is delayed by other extensions in the chain).
    if (editor) {
      editor.chain().dismissSlashMenu().run();
    }
    setSlashTrigger(SLASH_TRIGGER_INITIAL);
  }, [editor]);

  // Insert the chosen KChat user as a mention node, replacing the
  // active `@query` trigger range (Session 8 Task 2).
  const selectMention = useCallback(
    (user: KchatUserSearchResultView) => {
      if (!editor) return;
      const range = mentionTrigger.range ?? undefined;
      editor
        .chain()
        .focus()
        .insertKchatMention({
          id: user.id,
          label: user.username,
          range,
        })
        .run();
      setMentionTrigger(MENTION_TRIGGER_INITIAL);
    },
    [editor, mentionTrigger.range],
  );

  const dismissMention = useCallback(() => {
    if (editor) {
      editor.chain().dismissKchatMention().run();
    }
    setMentionTrigger(MENTION_TRIGGER_INITIAL);
  }, [editor]);

  const onPickImage = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      if (!editor) return;
      const file = e.target.files?.[0];
      // Reset so picking the same file twice in a row still fires.
      e.target.value = "";
      if (!file) return;
      try {
        const url = await fileToDataUrl(file);
        editor.chain().focus().setImage({ src: url, alt: file.name }).run();
      } catch (err) {
        window.alert((err as Error).message);
      }
    },
    [editor],
  );

  const insertImageFromToolbar = useCallback(() => {
    imageInputRef.current?.click();
  }, []);

  // Word/character counts derived from the editor's plain text. We
  // recompute on every render — TipTap's reactivity guarantees this
  // component re-renders on every doc change.
  const counts = useMemo(() => {
    if (!editor) return { characters: 0, charactersNoSpaces: 0, words: 0 };
    return countDocText(editor.getText());
    // `docVersion` is bumped in `onUpdate` (see above) on every
    // editor dispatch, which is what actually drives recomputation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, docVersion]);

  // Live comment threads, re-collected from the doc on every edit
  // (`docVersion` bumps in `onUpdate`). The `comment` mark IS the
  // store, so this stays in sync with persistence for free.
  const comments = useMemo<DocumentComment[]>(() => {
    if (!editor) return [];
    return collectCommentsFromDoc(editor.state.doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, docVersion]);

  const openCommentCount = countOpenComments(comments);

  // Prompt for a comment body and anchor it to the current selection.
  // A collapsed (empty) selection has nothing to anchor to, so we tell
  // the user to select text first rather than silently no-op-ing.
  const addCommentFromToolbar = useCallback(() => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    if (from >= to) {
      window.alert("Select some text first, then add a comment.");
      return;
    }
    const raw = window.prompt("Add a comment:");
    if (raw === null) return;
    const text = normalizeCommentText(raw);
    if (!text) return;
    editor
      .chain()
      .focus()
      .addComment({
        commentId: makeCommentId(),
        author: DEFAULT_COMMENT_AUTHOR,
        createdAt: new Date().toISOString(),
        text,
        resolved: false,
      })
      .run();
    setCommentsOpen(true);
  }, [editor]);

  const toggleCommentResolved = useCallback(
    (comment: DocumentComment) => {
      if (!editor) return;
      editor
        .chain()
        .focus()
        .setCommentResolved(comment.id, !comment.resolved)
        .run();
    },
    [editor],
  );

  const removeComment = useCallback(
    (comment: DocumentComment) => {
      if (!editor) return;
      editor.chain().focus().removeComment(comment.id).run();
    },
    [editor],
  );

  const jumpToComment = useCallback(
    (comment: DocumentComment) => {
      if (!editor) return;
      editor
        .chain()
        .focus()
        .setTextSelection({ from: comment.from, to: comment.to })
        .run();
    },
    [editor],
  );

  if (!editor) return null;

  return (
    <div className="document-editor">
      <Toolbar
        editor={editor}
        onSetLink={openLinkPopover}
        onInsertImage={insertImageFromToolbar}
        onOpenFind={() => setFindOpen(true)}
        onOpenAi={() => openAi()}
        onAddComment={addCommentFromToolbar}
        onToggleComments={() => setCommentsOpen((open) => !open)}
        commentsOpen={commentsOpen}
        openCommentCount={openCommentCount}
      />
      <div className="document-editor-outline">
        <OutlinePanel editor={editor} docVersion={docVersion} />
      </div>
      <div className="document-editor-content">
        <EditorContent editor={editor} />
        {findOpen && (
          <FindReplacePanel
            editor={editor}
            onClose={() => setFindOpen(false)}
          />
        )}
        {commentsOpen && (
          <CommentsPanel
            comments={comments}
            onToggleResolved={toggleCommentResolved}
            onRemove={removeComment}
            onJumpTo={jumpToComment}
            onClose={() => setCommentsOpen(false)}
          />
        )}
        {slashTrigger.visible && (
          <SlashMenu
            trigger={slashTrigger}
            onSelect={dispatchSlash}
            onDismiss={dismissSlash}
          />
        )}
        {mentionTrigger.visible && (
          <MentionMenu
            trigger={mentionTrigger}
            onSelect={selectMention}
            onDismiss={dismissMention}
          />
        )}
        {aiState && (
          <AiAssistantPanel
            editor={editor}
            context={aiState.context}
            initialAction={aiState.action}
            onClose={() => setAiState(null)}
          />
        )}
        {linkPopoverOpen && (
          <LinkPopover
            editor={editor}
            onClose={() => setLinkPopoverOpen(false)}
          />
        )}
      </div>
      <div className="document-editor-footer" aria-live="polite">
        <span>{counts.words} words</span>
        <span>{counts.characters} characters</span>
        <span>{counts.charactersNoSpaces} without spaces</span>
        <span>{formatReadingTime(counts.words)}</span>
      </div>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onPickImage}
        aria-hidden="true"
      />
    </div>
  );
}

// A live mark value (font family / size / line height read off the selection)
// can be something the user pasted from another app — e.g. `15px` or
// `'Helvetica Neue', sans-serif` — that isn't one of our presets. A controlled
// <select> with no matching <option> renders blank, misrepresenting the current
// formatting, so we append a display-only "custom" option that mirrors the live
// value. Picking a preset afterwards still applies cleanly.
function customTypographyOption(
  options: ReadonlyArray<{ value: string }>,
  current: string,
  label?: (value: string) => string,
) {
  const custom = customTypographyValue(
    options.map((o) => o.value),
    current,
  );
  if (custom === null) return null;
  return <option value={custom}>{label ? label(custom) : custom}</option>;
}

// Typography cluster: font family / size, text + highlight colour, horizontal
// alignment, and line height. Reads live marks off the current selection so the
// controls reflect the caret position; all writes go through editor commands so
// they participate in undo/redo and serialize into the saved HTML.
function TypographyControls({ editor }: { editor: Editor }) {
  const textStyle = editor.getAttributes("textStyle");
  const currentFont: string = textStyle.fontFamily ?? "";
  const currentSize: string = textStyle.fontSize ?? "";
  const currentColor: string = textStyle.color ?? "";
  // LineHeight is stored on the active block node (paragraph or heading).
  const currentLineHeight: string =
    editor.getAttributes("paragraph").lineHeight ??
    editor.getAttributes("heading").lineHeight ??
    "";
  const currentHighlight: string = editor.getAttributes("highlight").color ?? "";

  return (
    <div className="toolbar-typography" role="group" aria-label="Typography">
      <select
        className="toolbar-select"
        aria-label="Font family"
        title="Font family"
        value={currentFont}
        onChange={(e) => {
          const v = e.target.value;
          const chain = editor.chain().focus();
          if (v) chain.setFontFamily(v).run();
          else chain.unsetFontFamily().run();
        }}
      >
        {FONT_FAMILY_OPTIONS.map((o) => (
          <option key={o.label} value={o.value}>
            {o.label}
          </option>
        ))}
        {customTypographyOption(FONT_FAMILY_OPTIONS, currentFont, () => "Custom")}
      </select>
      <select
        className="toolbar-select toolbar-select-narrow"
        aria-label="Font size"
        title="Font size"
        value={currentSize}
        onChange={(e) => {
          const v = e.target.value;
          const chain = editor.chain().focus();
          if (v) chain.setFontSize(v).run();
          else chain.unsetFontSize().run();
        }}
      >
        {FONT_SIZE_OPTIONS.map((o) => (
          <option key={o.label} value={o.value}>
            {o.label}
          </option>
        ))}
        {customTypographyOption(FONT_SIZE_OPTIONS, currentSize)}
      </select>
      <label
        className={currentColor ? "toolbar-color active" : "toolbar-color"}
        title="Text color"
      >
        <Baseline size={16} aria-hidden="true" />
        <span
          className="toolbar-color-bar"
          style={{ background: currentColor || "currentColor" }}
          aria-hidden="true"
        />
        <input
          type="color"
          aria-label="Text color"
          value={currentColor || DEFAULT_TEXT_COLOR}
          onChange={(e) => editor.chain().focus().setColor(e.target.value).run()}
        />
      </label>
      <button
        type="button"
        className={editor.isActive("highlight") ? "toolbar-btn active" : "toolbar-btn"}
        title="Highlight"
        aria-label="Highlight"
        aria-pressed={editor.isActive("highlight")}
        onClick={() =>
          editor
            .chain()
            .focus()
            .toggleHighlight({ color: currentHighlight || DEFAULT_HIGHLIGHT_COLOR })
            .run()
        }
      >
        <Highlighter size={16} aria-hidden="true" />
      </button>
      <span className="toolbar-separator" />
      <div className="toolbar-align-group" role="group" aria-label="Text alignment">
        {TEXT_ALIGNMENTS.map(([value, Icon, label]) => {
          const active = editor.isActive({ textAlign: value });
          return (
            <button
              key={value}
              type="button"
              className={active ? "toolbar-btn active" : "toolbar-btn"}
              aria-label={label}
              title={label}
              aria-pressed={active}
              onClick={() => editor.chain().focus().setTextAlign(value).run()}
            >
              <Icon size={16} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <select
        className="toolbar-select toolbar-select-narrow"
        aria-label="Line height"
        title="Line height"
        value={currentLineHeight}
        onChange={(e) => {
          const v = e.target.value;
          const chain = editor.chain().focus();
          if (v) chain.setLineHeight(v).run();
          else chain.unsetLineHeight().run();
        }}
      >
        {LINE_HEIGHT_OPTIONS.map((o) => (
          <option key={o.label} value={o.value}>
            {o.label === "Default" ? "↕ Default" : `↕ ${o.label}`}
          </option>
        ))}
        {customTypographyOption(
          LINE_HEIGHT_OPTIONS,
          currentLineHeight,
          (v) => `↕ ${v}`,
        )}
      </select>
    </div>
  );
}

function Toolbar({
  editor,
  onSetLink,
  onInsertImage,
  onOpenFind,
  onOpenAi,
  onAddComment,
  onToggleComments,
  commentsOpen,
  openCommentCount,
}: {
  editor: Editor;
  onSetLink: () => void;
  onInsertImage: () => void;
  onOpenFind: () => void;
  onOpenAi: () => void;
  onAddComment: () => void;
  onToggleComments: () => void;
  commentsOpen: boolean;
  openCommentCount: number;
}) {
  const inTable = editor.isActive("table");
  return (
    <div className="editor-toolbar">
      <button
        type="button"
        className="toolbar-btn toolbar-btn-ai"
        onClick={onOpenAi}
        title="Ask AI (Ctrl+J)"
        aria-label="Ask AI"
      >
        <Sparkles size={15} aria-hidden="true" /> AI
      </button>
      <span className="toolbar-separator" />
      <button
        type="button"
        className={editor.isActive("bold") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (Ctrl+B)"
        aria-label="Bold"
        aria-pressed={editor.isActive("bold")}
      >
        <BoldIcon size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("italic") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (Ctrl+I)"
        aria-label="Italic"
        aria-pressed={editor.isActive("italic")}
      >
        <ItalicIcon size={16} aria-hidden="true" />
      </button>
      {/* Underline isn't imported explicitly: TipTap v3's StarterKit bundles
          and registers @tiptap/extension-underline by default (unlike v2), so
          toggleUnderline()/isActive("underline") are available without it. */}
      <button
        type="button"
        className={editor.isActive("underline") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        title="Underline (Ctrl+U)"
        aria-label="Underline"
        aria-pressed={editor.isActive("underline")}
      >
        <UnderlineIcon size={16} aria-hidden="true" />
      </button>
      <span className="toolbar-separator" />
      <TypographyControls editor={editor} />
      <span className="toolbar-separator" />
      <button
        type="button"
        className={editor.isActive("heading", { level: 1 }) ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title="Heading 1"
        aria-label="Heading 1"
        aria-pressed={editor.isActive("heading", { level: 1 })}
      >
        <Heading1 size={17} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("heading", { level: 2 }) ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Heading 2"
        aria-label="Heading 2"
        aria-pressed={editor.isActive("heading", { level: 2 })}
      >
        <Heading2 size={17} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("heading", { level: 3 }) ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        title="Heading 3"
        aria-label="Heading 3"
        aria-pressed={editor.isActive("heading", { level: 3 })}
      >
        <Heading3 size={17} aria-hidden="true" />
      </button>
      <span className="toolbar-separator" />
      <button
        type="button"
        className={editor.isActive("bulletList") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet List"
        aria-label="Bullet list"
        aria-pressed={editor.isActive("bulletList")}
      >
        <List size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("orderedList") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Ordered List"
        aria-label="Ordered list"
        aria-pressed={editor.isActive("orderedList")}
      >
        <ListOrdered size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("taskList") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        title="Task List"
        aria-label="Task list"
        aria-pressed={editor.isActive("taskList")}
      >
        <ListChecks size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("blockquote") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Blockquote"
        aria-label="Blockquote"
        aria-pressed={editor.isActive("blockquote")}
      >
        <Quote size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("codeBlock") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title="Code Block"
        aria-label="Code block"
        aria-pressed={editor.isActive("codeBlock")}
      >
        <Code2 size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={editor.isActive("link") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={onSetLink}
        title="Link (Ctrl+K)"
        aria-label="Insert link"
        aria-pressed={editor.isActive("link")}
      >
        <LinkIcon size={16} aria-hidden="true" />
      </button>
      <span className="toolbar-separator" />
      <button
        type="button"
        className="toolbar-btn"
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        }
        title="Insert Table"
        aria-label="Insert table"
      >
        <TableIcon size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={onInsertImage}
        title="Insert Image"
        aria-label="Insert image"
      >
        <ImageIcon size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Horizontal Rule"
        aria-label="Horizontal rule"
      >
        <Minus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => editor.chain().focus().insertMermaid().run()}
        title="Insert Mermaid diagram"
        aria-label="Insert diagram"
      >
        <Workflow size={16} aria-hidden="true" />
      </button>
      <span className="toolbar-separator" />
      {inTable && (
        <>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addRowAfter().run()}
            title="Add row below"
            aria-label="Add row below"
          >
            <BetweenHorizontalEnd size={16} aria-hidden="true" />
            <span className="toolbar-btn-label">Row</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            title="Add column right"
            aria-label="Add column right"
          >
            <BetweenVerticalEnd size={16} aria-hidden="true" />
            <span className="toolbar-btn-label">Column</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().deleteRow().run()}
            title="Delete row"
            aria-label="Delete row"
          >
            <Trash2 size={16} aria-hidden="true" />
            <span className="toolbar-btn-label">Row</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().deleteColumn().run()}
            title="Delete column"
            aria-label="Delete column"
          >
            <Trash2 size={16} aria-hidden="true" />
            <span className="toolbar-btn-label">Column</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().toggleHeaderRow().run()}
            title="Toggle header row"
            aria-label="Toggle header row"
          >
            <Heading size={16} aria-hidden="true" />
            <span className="toolbar-btn-label">Header</span>
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().mergeOrSplit().run()}
            title="Merge or split cells"
            aria-label="Merge or split cells"
          >
            <TableCellsMerge size={16} aria-hidden="true" />
            <span className="toolbar-btn-label">Merge</span>
          </button>
          <button
            type="button"
            className="toolbar-btn toolbar-btn-danger"
            onClick={() => editor.chain().focus().deleteTable().run()}
            title="Delete table"
            aria-label="Delete table"
          >
            <Trash2 size={16} aria-hidden="true" />
            <span className="toolbar-btn-label">Table</span>
          </button>
          <span className="toolbar-separator" />
        </>
      )}
      <button
        type="button"
        className="toolbar-btn"
        onClick={onOpenFind}
        title="Find & replace (Ctrl+F)"
        aria-label="Find and replace"
      >
        <Search size={16} aria-hidden="true" />
      </button>
      <span className="toolbar-separator" />
      <button
        type="button"
        className={
          editor.isActive("comment") ? "toolbar-btn active" : "toolbar-btn"
        }
        onClick={onAddComment}
        title="Comment on selection"
        aria-label="Comment on selection"
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={commentsOpen ? "toolbar-btn active" : "toolbar-btn"}
        onClick={onToggleComments}
        title="Toggle comments panel"
        aria-label="Toggle comments panel"
        aria-pressed={commentsOpen}
      >
        <MessageSquare size={16} aria-hidden="true" />
        <span className="toolbar-btn-label">
          Comments{openCommentCount > 0 ? ` (${openCommentCount})` : ""}
        </span>
      </button>
    </div>
  );
}

function OutlinePanel({
  editor,
  docVersion,
}: {
  editor: Editor;
  docVersion: number;
}) {
  // Headings re-collected on every doc edit (`docVersion` bumps in
  // `onUpdate`). Pure walk lives in `documentOutlineHelpers` so it's
  // unit-tested without TipTap.
  const headings = useMemo<HeadingEntry[]>(
    () => collectHeadings(editor.state.doc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor, docVersion],
  );

  const [activeIndex, setActiveIndex] = useState(0);

  // Latest headings, read by the scroll handler without being a dependency of
  // the listener effect — otherwise the (new-identity-every-keystroke)
  // `headings` array would tear down and re-register the DOM scroll listener
  // on every doc edit. The ref is refreshed in the recompute effect below.
  const headingsRef = useRef<HeadingEntry[]>(headings);

  // Read each heading's offset relative to the scroll container and mark the
  // last one crossed as active. Stable across doc edits (deps: [editor] only)
  // so the scroll listener effect doesn't churn.
  const recomputeActive = useCallback(() => {
    const scroller = editor.view.dom.closest(
      ".document-editor-content",
    ) as HTMLElement | null;
    if (!scroller) return;
    const containerTop = scroller.getBoundingClientRect().top;
    const offsets = headingsRef.current.map((h) => {
      const dom = editor.view.nodeDOM(h.pos);
      return dom instanceof HTMLElement
        ? dom.getBoundingClientRect().top - containerTop
        : Number.POSITIVE_INFINITY;
    });
    setActiveIndex(pickActiveHeadingIndex(offsets, 0));
  }, [editor]);

  // Register the scroll listener once per editor. Passive + rAF-throttled so
  // it never blocks scrolling.
  useEffect(() => {
    const scroller = editor.view.dom.closest(
      ".document-editor-content",
    ) as HTMLElement | null;
    if (!scroller) return;

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        recomputeActive();
      });
    };

    recomputeActive();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [editor, recomputeActive]);

  // On a doc edit the heading set changes: refresh the ref and recompute the
  // active heading, without re-registering the scroll listener above.
  useEffect(() => {
    headingsRef.current = headings;
    recomputeActive();
  }, [headings, recomputeActive]);

  const jumpTo = useCallback(
    (entry: HeadingEntry) => {
      editor.chain().focus().setTextSelection(entry.pos + 1).run();
      const dom = editor.view.nodeDOM(entry.pos);
      if (dom instanceof HTMLElement) {
        const reduceMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        dom.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "start",
        });
      }
    },
    [editor],
  );

  if (headings.length === 0) {
    return <div className="outline-empty">No headings yet</div>;
  }

  return (
    <nav className="outline-nav" aria-label="Document outline">
      <div className="outline-title">Outline</div>
      {headings.map((h, i) => (
        <button
          key={h.id}
          type="button"
          className={
            i === activeIndex ? "outline-item outline-item-active" : "outline-item"
          }
          aria-current={i === activeIndex ? "true" : undefined}
          style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
          onClick={() => jumpTo(h)}
        >
          {h.text || "(empty heading)"}
        </button>
      ))}
    </nav>
  );
}
