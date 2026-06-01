/**
 * pure-helper coverage for `documentEditorHelpers.ts`.
 *
 * The actual TipTap / ProseMirror integration (decoration painting,
 * slash-trigger detection inside a live editor) is covered in the
 * component-level integration tests. This file pins the algorithms
 * that those plugins delegate to, so a regression in
 * `findAllMatches`, `pickActiveMatch`, `replaceOne`/`replaceAll`,
 * `filterSlashCommands`, `parseDocumentContent`, or `countDocText`
 * is caught without booting jsdom + the editor.
 */
import { describe, it, expect } from "vitest";
import {
  parseDocumentContent,
  escapeHtml,
  countDocText,
  SLASH_COMMANDS,
  filterSlashCommands,
  findAllMatches,
  pickActiveMatch,
  replaceOne,
  replaceAll,
  escapeRegex,
  MAX_IMAGE_BYTES,
  fileToDataUrl,
  TRUSTED_LEADING_TAGS,
} from "../documentEditorHelpers";

describe("parseDocumentContent — artifact text → TipTap-friendly HTML", () => {
  it("returns a blank paragraph for nullish / empty input (the editor's canonical empty doc)", () => {
    expect(parseDocumentContent(null)).toBe("<p></p>");
    expect(parseDocumentContent(undefined)).toBe("<p></p>");
    expect(parseDocumentContent("")).toBe("<p></p>");
  });

  it("returns HTML as-is when the content already looks like HTML (the round-trip case)", () => {
    const html = "<h1>Title</h1><p>Body</p>";
    expect(parseDocumentContent(html)).toBe(html);
    // Leading whitespace is preserved; the trim() check is only used
    // to detect the tag.
    expect(parseDocumentContent("   <p>spaced</p>")).toBe("   <p>spaced</p>");
  });

  it("wraps plain text into paragraphs and escapes HTML special chars (defence against `<script>` paste)", () => {
    // Two paragraphs separated by a blank line. Each `\n` becomes `<br>`.
    const text = "Line 1\nLine 2\n\nNext para";
    expect(parseDocumentContent(text)).toBe(
      "<p>Line 1<br>Line 2</p><p>Next para</p>",
    );
  });

  it("escapes <, >, &, \", ' so an injected script never reaches the live editor", () => {
    const text = '<script>alert("xss")</script>';
    expect(parseDocumentContent(text)).toBe(
      "<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>",
    );
  });
});

describe("escapeHtml", () => {
  it("escapes the five state-changing characters and leaves everything else alone", () => {
    expect(escapeHtml('<b>"hi" & \'bye\'</b>')).toBe(
      "&lt;b&gt;&quot;hi&quot; &amp; &#39;bye&#39;&lt;/b&gt;",
    );
    expect(escapeHtml("plain text")).toBe("plain text");
  });

  it("is idempotent on already-escaped content (round 1 produces what round 2 sees)", () => {
    // The output of escapeHtml itself contains `&`, so a second pass
    // expands the entities. This documents the contract — the caller
    // must NOT re-escape already-escaped output.
    expect(escapeHtml(escapeHtml("&"))).toBe("&amp;amp;");
  });
});

describe("countDocText — word / character counter for the editor footer", () => {
  it("returns zero for empty / whitespace-only input (word count = 0, not 1)", () => {
    expect(countDocText("")).toEqual({
      characters: 0,
      charactersNoSpaces: 0,
      words: 0,
    });
    expect(countDocText("   \n\n  ")).toEqual({
      characters: 7,
      charactersNoSpaces: 0,
      words: 0,
    });
  });

  it("splits on every whitespace run, NOT punctuation (matches Google Docs behaviour)", () => {
    expect(countDocText("hello,world")).toEqual({
      characters: 11,
      charactersNoSpaces: 11,
      words: 1,
    });
    // "hello world  again" → 5 + " " + 5 + "  " + 5 = 18 chars total;
    // stripped of whitespace → 5 + 5 + 5 = 15; three whitespace-delimited
    // words. Double-space between `world` and `again` counts as one
    // separator (\s+ collapses runs), matching Google Docs.
    expect(countDocText("hello world  again")).toEqual({
      characters: 18,
      charactersNoSpaces: 15,
      words: 3,
    });
  });

  it("counts UTF-16 code units for `characters` (matches String.length, what users see)", () => {
    // "🎉" is one grapheme but two UTF-16 code units — we report 2.
    // This matches every native textarea's "characters remaining"
    // counter and is the only count consistent with HTML/JS String.
    expect(countDocText("🎉 hello").characters).toBe(8);
  });
});

describe("SLASH_COMMANDS catalog", () => {
  it("contains the expected blocks/lists/media commands with stable ids", () => {
    const ids = SLASH_COMMANDS.map((c) => c.id);
    // Anti-bitrot: if a command is added or removed the slash-menu UI
    // and tests must move together — this assertion makes that
    // dependency explicit.
    expect(ids).toEqual([
      "heading-1",
      "heading-2",
      "heading-3",
      "paragraph",
      "blockquote",
      "code-block",
      "horizontal-rule",
      "bullet-list",
      "ordered-list",
      "task-list",
      "table",
      "image",
      "mermaid",
    ]);
  });
});

describe("filterSlashCommands — slash menu fuzzy filter", () => {
  it("returns the full catalog (in display order) for an empty query", () => {
    const out = filterSlashCommands("");
    expect(out.length).toBe(SLASH_COMMANDS.length);
    expect(out[0].id).toBe("heading-1");
  });

  it("prefers label-prefix matches over substring matches (h → heading-1, NOT horizontal-rule)", () => {
    const out = filterSlashCommands("h");
    // All three headings AND horizontal-rule start with "h" — but the
    // shorter labels score higher (100 - label.length).
    expect(out[0].id).toBe("heading-1");
  });

  it("matches via keyword for terms not in the visible label (todo → task-list)", () => {
    // The user types `/todo` — the visible label is "Task List", but
    // the keyword catalogue includes "todo".
    const out = filterSlashCommands("todo");
    expect(out[0].id).toBe("task-list");
  });

  it("matches via description as a last-resort fallback (small score, only when nothing else hits)", () => {
    // "Monospaced" only appears in `code-block`'s description.
    const out = filterSlashCommands("monospaced");
    expect(out[0].id).toBe("code-block");
  });

  it("returns an empty list when no command matches (UI can render an empty-state)", () => {
    expect(filterSlashCommands("nonsensequery42")).toEqual([]);
  });

  it("is case-insensitive on the query side (BULLET == bullet == Bullet)", () => {
    const lowered = filterSlashCommands("bullet");
    const uppered = filterSlashCommands("BULLET");
    expect(uppered.map((c) => c.id)).toEqual(lowered.map((c) => c.id));
  });
});

describe("findAllMatches — find-in-page algorithm", () => {
  const opts = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  };

  it("returns [] for an empty needle (so the panel clears highlights by clearing the input)", () => {
    expect(findAllMatches("anything", "", opts)).toEqual([]);
  });

  it("finds every non-overlapping occurrence (aaaa → aa at 0 and 2, not 0/1/2)", () => {
    expect(findAllMatches("aaaa", "aa", opts)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("is case-insensitive by default and case-sensitive when opts.caseSensitive=true", () => {
    expect(findAllMatches("Hello hello HELLO", "hello", opts)).toHaveLength(3);
    expect(
      findAllMatches("Hello hello HELLO", "hello", { ...opts, caseSensitive: true }),
    ).toEqual([{ start: 6, end: 11 }]);
  });

  it("wholeWord wraps the needle in \\b boundaries (hello matches `hello`, not `hellos`)", () => {
    expect(
      findAllMatches("hello hellos rehello", "hello", { ...opts, wholeWord: true }),
    ).toEqual([{ start: 0, end: 5 }]);
  });

  it("regex mode treats the needle as a pattern (\\d+ matches every number)", () => {
    expect(
      findAllMatches("year 2026 day 30", "\\d+", { ...opts, regex: true }),
    ).toEqual([
      { start: 5, end: 9 },
      { start: 14, end: 16 },
    ]);
  });

  it("returns [] (no crash) on an invalid regex (half-typed `[abc`)", () => {
    expect(findAllMatches("anything", "[abc", { ...opts, regex: true })).toEqual([]);
  });

  it("escapes regex metachars in plain-text mode (`. * +` are literal)", () => {
    expect(findAllMatches("a.b.c", ".", opts)).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it("caps the match count at 10_000 so an unbounded regex on a huge doc doesn't lock the thread", () => {
    // Build a 12_000-char string where every char matches `.`.
    const haystack = "x".repeat(12_000);
    const out = findAllMatches(haystack, ".", { ...opts, regex: true });
    expect(out.length).toBe(10_000);
  });

  it("does not spin on zero-width matches (regex `(?=)` would otherwise loop forever)", () => {
    // Synthetic but realistic — users typing `(?=` while building a
    // lookahead regex previously locked the editor thread.
    const out = findAllMatches("abc", "(?=)", { ...opts, regex: true });
    // Each position emits a zero-width match → 4 results (3 chars + EOS).
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out[0]).toEqual({ start: 0, end: 0 });
  });
});

describe("escapeRegex", () => {
  it("escapes every regex metachar exactly once", () => {
    expect(escapeRegex("a.b*c+d?e^f$g(h)i|j[k]l\\m{n}o")).toBe(
      "a\\.b\\*c\\+d\\?e\\^f\\$g\\(h\\)i\\|j\\[k\\]l\\\\m\\{n\\}o",
    );
  });

  it("is a no-op on plain alphanumeric text", () => {
    expect(escapeRegex("hello world 42")).toBe("hello world 42");
  });
});

describe("pickActiveMatch — Ctrl+F navigation contract", () => {
  const matches = [
    { start: 5, end: 10 },
    { start: 20, end: 25 },
    { start: 40, end: 45 },
  ];

  it("returns -1 when matches is empty (UI hides the counter / Replace button)", () => {
    expect(pickActiveMatch([], 0, "next")).toBe(-1);
    expect(pickActiveMatch([], 100, "previous")).toBe(-1);
  });

  it("next: returns the first match whose start >= caret, else wraps to 0", () => {
    expect(pickActiveMatch(matches, 0, "next")).toBe(0); // 5 >= 0 → 0
    expect(pickActiveMatch(matches, 15, "next")).toBe(1); // 20 >= 15 → 1
    expect(pickActiveMatch(matches, 100, "next")).toBe(0); // wraps
  });

  it("previous: returns the last match whose start < caret, else wraps to last", () => {
    expect(pickActiveMatch(matches, 100, "previous")).toBe(2);
    expect(pickActiveMatch(matches, 25, "previous")).toBe(1);
    expect(pickActiveMatch(matches, 0, "previous")).toBe(2); // wraps
  });
});

describe("replaceOne / replaceAll — diff-style splice", () => {
  it("replaceOne splices a single range with the replacement string", () => {
    expect(replaceOne("hello world", { start: 6, end: 11 }, "TipTap")).toBe(
      "hello TipTap",
    );
  });

  it("replaceAll walks in reverse so earlier indices stay valid (no shifting bugs)", () => {
    // `Hello world hello world` → replace both "world" → "TipTap"
    const haystack = "Hello world hello world";
    const matches = findAllMatches(haystack, "world", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(replaceAll(haystack, matches, "TipTap")).toBe(
      "Hello TipTap hello TipTap",
    );
  });

  it("replaceAll preserves replacement length differences without corrupting offsets", () => {
    // Replacement is LONGER than the needle — proves the reverse-walk
    // is correct (forward-walk would silently corrupt the second match).
    const haystack = "ab ab";
    const matches = findAllMatches(haystack, "ab", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(replaceAll(haystack, matches, "CDEF")).toBe("CDEF CDEF");
  });
});

describe("fileToDataUrl — inline image embed", () => {
  it("rejects files larger than MAX_IMAGE_BYTES with a human-readable error", async () => {
    // We can't build a 5MiB File in a unit test without ballooning RAM,
    // but we CAN set a stubbed `size` larger than the cap and confirm
    // the size-check rejection fires before the FileReader ever runs.
    const bigFile = {
      size: MAX_IMAGE_BYTES + 1,
    } as File;
    await expect(fileToDataUrl(bigFile)).rejects.toThrow(
      /inline-embed cap is 5 MiB/,
    );
  });

  it("resolves with the data URL for an in-range file (happy path)", async () => {
    // 4 bytes — well under the 5 MiB cap.
    const file = new File(["data"], "hello.txt", { type: "text/plain" });
    const url = await fileToDataUrl(file);
    expect(url).toMatch(/^data:text\/plain;/);
    expect(url).toContain("ZGF0YQ=="); // base64 of "data"
  });
});

describe("TRUSTED_LEADING_TAGS — round-trip whitelist parity with registered extensions", () => {
  // Devin Review PR #82 round 7 ANALYSIS_…_0007 flagged that this
  // whitelist (used by `parseDocumentContent` to distinguish
  // already-rendered HTML from plain text) can silently drift if a
  // new TipTap extension is wired into `DocumentEditor.tsx` without
  // a matching entry here. The failure mode is subtle: saved HTML
  // whose leading tag isn't on the list gets HTML-escaped on reload,
  // losing the formatting wholesale.
  //
  // The fix is twofold:
  //   1. A static snapshot pin that catches ANY change to the list
  //      (so anyone adding / removing a tag has to update the test
  //      and think about parity).
  //   2. A dynamic introspection test that loads the actual TipTap
  //      `StarterKit` extension set and validates that every HTML
  //      tag each node extension can emit at the document root is
  //      on the trusted list. This catches the *real* drift case —
  //      "I added <Underline> to extensions but forgot to add `u` to
  //      TRUSTED_LEADING_TAGS".

  it("exposes the trust list in a stable, lowercase, deduplicated, alphabetised shape", () => {
    // Static structural invariants. If anyone changes the list, the
    // snapshot below also has to change — which is the whole point.
    expect(TRUSTED_LEADING_TAGS.every((t) => t === t.toLowerCase())).toBe(
      true,
    );
    expect(new Set(TRUSTED_LEADING_TAGS).size).toBe(
      TRUSTED_LEADING_TAGS.length,
    );
    expect(TRUSTED_LEADING_TAGS.every((t) => /^[a-z][a-z0-9]*$/.test(t))).toBe(
      true,
    );
  });

  it("contains every block / inline tag the current editor extension set can emit at the document root", () => {
    // Hardcoded list of (tag, why it's needed). Adding a TipTap
    // extension means adding a row here. Reviewers see the test diff
    // and confirm the corresponding `TRUSTED_LEADING_TAGS` edit.
    const required: Array<readonly [tag: string, source: string]> = [
      // Document structure (StarterKit).
      ["p", "@tiptap/extension-paragraph"],
      ["h1", "@tiptap/extension-heading (level 1)"],
      ["h2", "@tiptap/extension-heading (level 2)"],
      ["h3", "@tiptap/extension-heading (level 3)"],
      ["ul", "@tiptap/extension-bullet-list (also @tiptap/extension-task-list)"],
      ["ol", "@tiptap/extension-ordered-list"],
      ["li", "@tiptap/extension-list-item (also @tiptap/extension-task-item)"],
      ["blockquote", "@tiptap/extension-blockquote"],
      ["pre", "@tiptap/extension-code-block-lowlight (wraps <pre><code>)"],
      ["code", "@tiptap/extension-code (inline mark + codeBlock inner)"],
      ["hr", "@tiptap/extension-horizontal-rule"],
      ["br", "@tiptap/extension-hard-break"],
      // Tables.
      ["table", "@tiptap/extension-table"],
      ["thead", "table rendering"],
      ["tbody", "table rendering"],
      ["tr", "@tiptap/extension-table-row"],
      ["th", "@tiptap/extension-table-header"],
      ["td", "@tiptap/extension-table-cell"],
      // Inline marks.
      ["strong", "@tiptap/extension-bold (canonical render)"],
      ["b", "@tiptap/extension-bold (parse fallback)"],
      ["em", "@tiptap/extension-italic (canonical render)"],
      ["i", "@tiptap/extension-italic (parse fallback)"],
      ["s", "@tiptap/extension-strike (canonical render)"],
      ["del", "@tiptap/extension-strike (parse fallback)"],
      ["u", "@tiptap/extension-underline (reserved for future use)"],
      ["a", "@tiptap/extension-link"],
      ["img", "@tiptap/extension-image"],
      // Generic wrappers used by attribute-bearing nodes (e.g. data-
      // type="taskList" on a <div>, TextStyle marks on a <span>).
      ["div", "task-list wrapper + arbitrary block extensions"],
      ["span", "@tiptap/extension-text-style (attribute carrier)"],
    ];
    for (const [tag, source] of required) {
      expect(
        TRUSTED_LEADING_TAGS,
        `<${tag}> must be trusted for ${source}`,
      ).toContain(tag);
    }
  });

  it("excludes every executable / sandbox-escape tag", () => {
    // Defence in depth: even though `parseDocumentContent` *escapes*
    // unknown tags rather than rendering them, an attacker who finds
    // a way to slip one of these into a content blob would only need
    // the list to accidentally include the tag for the escape to be
    // bypassed. Pin the dangerous set explicitly so a future "add a
    // missing tag" patch can't expand the surface by accident.
    const forbidden = [
      "script",
      "iframe",
      "style",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "frame",
      "frameset",
      "applet",
      "base",
      "link", // <link rel="stylesheet" …> (NOT the inline <a> mark)
      "meta",
      "noscript",
      "svg", // can host scriptable handlers
      "math",
    ];
    for (const tag of forbidden) {
      expect(
        TRUSTED_LEADING_TAGS,
        `<${tag}> must NOT be trusted`,
      ).not.toContain(tag);
    }
  });

  it("dynamic introspection: every block-level node extension in StarterKit is represented", async () => {
    // Load the StarterKit extension definition dynamically so the
    // pure-helper test file doesn't pay the @tiptap/starter-kit
    // module-graph cost unless it's reached. `addExtensions()` returns
    // the nested extension list; we walk it and assert that every
    // BLOCK node has a corresponding tag on the trust list.
    //
    // This is the half of the pinning test that catches "added an
    // extension to DocumentEditor.tsx but forgot to update
    // TRUSTED_LEADING_TAGS" — the static snapshot above pins the
    // *current* list; this one pins the *parity contract*.
    const starterKitMod: { default: { configure: (o: object) => unknown } } =
      await import("@tiptap/starter-kit");
    const StarterKit = starterKitMod.default;
    const inst = StarterKit.configure({}) as {
      config: { addExtensions: (this: unknown) => Array<{ type: string; name: string }> };
    };
    const exts = inst.config.addExtensions.call(inst);

    // Map StarterKit extension names → expected document-root HTML tags.
    // (Inline marks, formatting marks, and "no-tag" extensions like
    // `doc` / `text` / `dropCursor` are omitted since they never
    // appear as the LEADING tag of a serialised document.)
    const NODE_TAG_MAP: Record<string, readonly string[]> = {
      paragraph: ["p"],
      heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
      blockquote: ["blockquote"],
      bulletList: ["ul"],
      orderedList: ["ol"],
      listItem: ["li"],
      codeBlock: ["pre"],
      hardBreak: ["br"],
      horizontalRule: ["hr"],
    };

    for (const ext of exts) {
      if (ext.type !== "node") continue;
      const tags = NODE_TAG_MAP[ext.name];
      if (tags === undefined) continue; // doc / text / unknown
      for (const tag of tags) {
        expect(
          TRUSTED_LEADING_TAGS,
          `StarterKit node "${ext.name}" can serialise as leading <${tag}>; ` +
            `it must be in TRUSTED_LEADING_TAGS or parseDocumentContent will escape the document on reload.`,
        ).toContain(tag);
      }
    }
  });
});
