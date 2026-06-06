import {
  useEffect,
  useCallback,
  useRef,
  useState,
  useMemo,
  type ChangeEvent,
} from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
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
import { common, createLowlight } from "lowlight";
import { MermaidNode } from "./extensions/MermaidExtension";
import {
  FindReplaceExtension,
} from "./extensions/FindReplaceExtension";
import {
  SlashCommandExtension,
  type SlashTriggerState,
} from "./extensions/SlashCommandExtension";
import {
  CommentMark,
  collectCommentsFromDoc,
} from "./extensions/CommentMark";
import {
  parseDocumentContent,
  countDocText,
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

  // File-picker ref for the toolbar's image upload button. We keep
  // the underlying `<input type=file>` in the DOM but visually hidden
  // so screen readers can still surface it.
  const imageInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
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
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: "plaintext",
      }),
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
      FindReplaceExtension,
      CommentMark,
      SlashCommandExtension.configure({
        onStateChange: (state) => setSlashTrigger(state),
      }),
    ],
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
    if (editor) {
      const parsed = parseDocumentContent(content);
      // Only update editor if content came from an external source (not our own save)
      if (parsed !== lastSavedRef.current) {
        editor.commands.setContent(parsed);
        lastSavedRef.current = editor.getHTML();
      }
    }
  }, [content, editor]);

  // Ctrl/Cmd+F opens the find panel. We bind on the editor's wrapping
  // div so the binding only fires when the editor has focus — global
  // capture would steal the browser's own Ctrl+F when the user is on
  // a different panel.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    dom.addEventListener("keydown", onKeyDown);
    return () => {
      dom.removeEventListener("keydown", onKeyDown);
    };
  }, [editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("Enter URL:");
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  }, [editor]);

  // Common splice for slash-menu activation: drop the `/<query>`
  // text, then dispatch the chosen block insert. Centralised here so
  // every command runs through the same cleanup.
  const dispatchSlash = useCallback(
    (cmd: SlashCommand) => {
      if (!editor) return;
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
        default:
          chain.run();
          break;
      }
      setSlashTrigger(SLASH_TRIGGER_INITIAL);
    },
    [editor],
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
        onSetLink={setLink}
        onInsertImage={insertImageFromToolbar}
        onOpenFind={() => setFindOpen(true)}
        onAddComment={addCommentFromToolbar}
        onToggleComments={() => setCommentsOpen((open) => !open)}
        commentsOpen={commentsOpen}
        openCommentCount={openCommentCount}
      />
      <div className="document-editor-outline">
        <OutlinePanel editor={editor} />
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
      </div>
      <div className="document-editor-footer" aria-live="polite">
        <span>{counts.words} words</span>
        <span>{counts.characters} characters</span>
        <span>{counts.charactersNoSpaces} without spaces</span>
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

function Toolbar({
  editor,
  onSetLink,
  onInsertImage,
  onOpenFind,
  onAddComment,
  onToggleComments,
  commentsOpen,
  openCommentCount,
}: {
  editor: Editor;
  onSetLink: () => void;
  onInsertImage: () => void;
  onOpenFind: () => void;
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
        className={editor.isActive("bold") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold"
      >
        B
      </button>
      <button
        type="button"
        className={editor.isActive("italic") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic"
      >
        I
      </button>
      <span className="toolbar-separator" />
      <button
        type="button"
        className={editor.isActive("heading", { level: 1 }) ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        title="Heading 1"
      >
        H1
      </button>
      <button
        type="button"
        className={editor.isActive("heading", { level: 2 }) ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        title="Heading 2"
      >
        H2
      </button>
      <button
        type="button"
        className={editor.isActive("heading", { level: 3 }) ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        title="Heading 3"
      >
        H3
      </button>
      <span className="toolbar-separator" />
      <button
        type="button"
        className={editor.isActive("bulletList") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet List"
      >
        UL
      </button>
      <button
        type="button"
        className={editor.isActive("orderedList") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Ordered List"
      >
        OL
      </button>
      <button
        type="button"
        className={editor.isActive("taskList") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
        title="Task List"
      >
        ☑
      </button>
      <button
        type="button"
        className={editor.isActive("blockquote") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Blockquote"
      >
        BQ
      </button>
      <button
        type="button"
        className={editor.isActive("codeBlock") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        title="Code Block"
      >
        {"</>"}
      </button>
      <button
        type="button"
        className={editor.isActive("link") ? "toolbar-btn active" : "toolbar-btn"}
        onClick={onSetLink}
        title="Link"
      >
        LK
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
      >
        ⊞
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={onInsertImage}
        title="Insert Image"
      >
        IMG
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title="Horizontal Rule"
      >
        —
      </button>
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => editor.chain().focus().insertMermaid().run()}
        title="Insert Mermaid diagram"
      >
        Diagram
      </button>
      <span className="toolbar-separator" />
      {inTable && (
        <>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addRowAfter().run()}
            title="Add row"
          >
            +R
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            title="Add column"
          >
            +C
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().deleteRow().run()}
            title="Delete row"
          >
            -R
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().deleteColumn().run()}
            title="Delete column"
          >
            -C
          </button>
          <button
            type="button"
            className="toolbar-btn"
            onClick={() => editor.chain().focus().deleteTable().run()}
            title="Delete table"
          >
            ✕
          </button>
          <span className="toolbar-separator" />
        </>
      )}
      <button
        type="button"
        className="toolbar-btn"
        onClick={onOpenFind}
        title="Find & replace (Ctrl+F)"
      >
        🔍
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
        💬+
      </button>
      <button
        type="button"
        className={commentsOpen ? "toolbar-btn active" : "toolbar-btn"}
        onClick={onToggleComments}
        title="Toggle comments panel"
        aria-label="Toggle comments panel"
        aria-pressed={commentsOpen}
      >
        Comments{openCommentCount > 0 ? ` (${openCommentCount})` : ""}
      </button>
    </div>
  );
}

function OutlinePanel({ editor }: { editor: Editor }) {
  const headings: { level: number; text: string; pos: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      headings.push({
        level: node.attrs.level as number,
        text: node.textContent,
        pos,
      });
    }
  });

  if (headings.length === 0) {
    return <div className="outline-empty">No headings yet</div>;
  }

  return (
    <nav className="outline-nav">
      <div className="outline-title">Outline</div>
      {headings.map((h, i) => (
        <button
          key={i}
          type="button"
          className="outline-item"
          style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
          onClick={() => {
            editor.commands.focus();
            editor.commands.setTextSelection(h.pos);
          }}
        >
          {h.text || "(empty heading)"}
        </button>
      ))}
    </nav>
  );
}
