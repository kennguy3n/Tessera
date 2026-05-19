import { useEffect, useCallback, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";

interface DocumentEditorProps {
  content: string;
  onSave: (content: string) => void;
  autoSaveMs?: number;
}

export default function DocumentEditor({
  content,
  onSave,
  autoSaveMs = 2000,
}: DocumentEditorProps) {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: "Start writing your document...",
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
      }),
    ],
    content: parseContent(content),
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      if (html === lastSavedRef.current) return;

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = setTimeout(() => {
        lastSavedRef.current = html;
        onSave(html);
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
    if (editor && content !== lastSavedRef.current) {
      editor.commands.setContent(parseContent(content));
      lastSavedRef.current = content;
    }
  }, [content, editor]);

  const setLink = useCallback(() => {
    if (!editor) return;
    const url = window.prompt("Enter URL:");
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="document-editor">
      <Toolbar editor={editor} onSetLink={setLink} />
      <div className="document-editor-outline">
        <OutlinePanel editor={editor} />
      </div>
      <div className="document-editor-content">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({
  editor,
  onSetLink,
}: {
  editor: ReturnType<typeof useEditor>;
  onSetLink: () => void;
}) {
  if (!editor) return null;

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
    </div>
  );
}

function OutlinePanel({ editor }: { editor: ReturnType<typeof useEditor> }) {
  if (!editor) return null;

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

function parseContent(content: string): string {
  if (!content) return "<p></p>";
  // If content already looks like HTML, use it directly
  if (content.trim().startsWith("<")) return content;
  // Otherwise, wrap plain text in paragraphs
  return content
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
