/**
 * Pure helper functions consumed by `ComparisonResultModal.tsx`.
 *
 * Lives in a sibling module rather than the component file so
 * React Fast Refresh can preserve component state across HMR
 * edits — mixing function exports alongside a component export
 * breaks the fast-refresh boundary and causes the entire modal
 * subtree to remount on every save. All three helpers are pure
 * (same input → same output, no side effects on `formatSimilarity`
 * / `sanitizeForFilename`; `downloadMarkdown` touches `document`
 * + `URL` but doesn't depend on React).
 */

/**
 * Format the bridge-side `similarityScore` (a value in `[0.0, 1.0]`)
 * as a percentage string with no fractional digit. Matches the
 * `to_markdown` rendering in
 * `crates/tessera_artifacts/src/comparison.rs` so the modal heading
 * matches what the user would see if they opened the comparison
 * artifact.
 */
export function formatSimilarity(score: number): string {
  // Guard against a malformed bridge response (NaN / Infinity)
  // landing on the renderer — `Math.round(NaN) * 100` would render
  // "NaN%" which is worse than just falling back to "0%". This is
  // exported for the regression test in
  // `ComparisonResultModal.test.tsx` so the contract is pinned.
  if (!Number.isFinite(score)) return "0%";
  const clamped = Math.max(0, Math.min(1, score));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Trigger a browser download of `markdown` named `filename`. Used
 * by the modal's "Download as Markdown" affordance. Implemented
 * client-side (Blob + Object URL) rather than going through the
 * bridge because the IPC `exportArtifactToFile` channel requires
 * a real artifact id + format pair, and the user might want to
 * snapshot the comparison without committing to the artifact path
 * — they can navigate to the persisted artifact via the modal's
 * "Open artifact" button if they want the IPC export path
 * instead.
 */
export function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    // Nest the anchor cleanup inside an inner try/finally so that
    // if `a.click()` throws (cf. some Electron versions on Linux
    // throw on missing display permissions), the anchor is still
    // removed before we propagate the throw up to the outer
    // `finally` that revokes the URL. Without this nesting a
    // failed click would leak an invisible `<a>` into `document.body`.
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Sanitize a source label so it is safe to use inside a download
 * filename across the three platforms the desktop app targets
 * (macOS, Windows, Linux). Strips the reserved-character set
 * `<>:"/\\|?*` plus control codepoints, collapses whitespace to a
 * single dash, and trims to a reasonable length so a 4 KB source
 * path can't produce a 4 KB filename.
 */
export function sanitizeForFilename(label: string): string {
  // Strip Windows-reserved characters + control codepoints +
  // whitespace into a single dash separator. Doing this in one
  // pass avoids the ordering trap where the control-char filter
  // would strip `\t` / `\n` BEFORE the whitespace collapse could
  // turn them into separators (producing "hello-worldtab" instead
  // of "hello-world-tab"). Then collapse runs and trim ends.
  //
  // The control-code ranges deliberately cover BOTH the C0 block
  // (`\u0000-\u001f`: tab / newline / etc) AND the DEL + C1 block
  // (`\u007f-\u009f`: DEL plus the secondary control range used by
  // ISO-8859 etc). Filesystems on the three target platforms allow
  // some of these in principle (Linux ext4 will accept `\u008c` in
  // a filename) but they render as garbage in every shell / file
  // picker we've tested, so neutralizing the whole control region
  // is the defensive default. Source labels coming from
  // `friendly_source_label` are filesystem-path-derived so should
  // never contain these — but `sanitizeForFilename` is exported as
  // a utility and a future caller could legitimately feed it
  // user-typed input. eslint's `no-control-regex` flags both ranges
  // as suspect (security: control chars in URL parsers are
  // typically a red flag) but here we are sanitizing FOR a
  // filename, not parsing an input — keeping the full control
  // region is necessary to neutralize them.
  // eslint-disable-next-line no-control-regex
  const reservedOrWhitespace = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\s]/g;
  const stripped = label
    .replace(reservedOrWhitespace, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Re-strip trailing dashes after the length cap so a label that
  // produces "foo-bar-baz-..." longer than 60 characters can't leave
  // a trailing dash at position 60 (cosmetic, but a dot/dash-final
  // filename looks broken in file pickers). Trimming both ends keeps
  // the empty-result branch reachable for purely-stripped inputs.
  const trimmed = stripped.slice(0, 60).replace(/^-+|-+$/g, "");
  return trimmed.length === 0 ? "source" : trimmed;
}
