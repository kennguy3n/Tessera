/**
 * HTML-escape a string for safe interpolation into HTML attribute values
 * and element content in renderer-side `buildPreviewHtml` /
 * `buildLandingPreviewHtml` template builders.
 *
 * Replaces the five HTML-significant characters with their named (or
 * numeric, for `'`) entity references. The order matters: `&` MUST be
 * replaced first so the `&` introduced by subsequent replacements is not
 * double-escaped.
 *
 * This is the single source of truth for the editor preview-rendering
 * escape layer — previously `InfographicEditor.tsx` and
 * `LandingPageEditor.tsx` each shipped a byte-identical private copy.
 * Devin Review on PR #41 flagged the duplication as a maintenance risk
 * (any future fix to the escape logic — adding non-character-reference
 * sanitisation, switching to a different entity for `'`, etc. — had to
 * be applied in both places independently). The extraction also
 * positions a future renderer or export pipeline that needs the same
 * escape contract to import from one canonical helper rather than
 * inventing its own.
 *
 * Notes for callers:
 *   - This function does NOT strip URL schemes. For attribute slots
 *     that hold a URL (`href`, `src`), route through `sanitizeUrl`
 *     first — `javascript:` is not an HTML-special character sequence
 *     and would pass through `escapeHtml` unchanged.
 *   - For non-string inputs that are runtime-guaranteed to render to a
 *     safe digits-only / alphanumerics-only string (e.g. width /
 *     height after `Number.isSafeInteger` validation), wrap with
 *     `escapeHtml(String(...))` anyway — the call is a no-op at
 *     runtime but pins the invariant that EVERY user-derived
 *     interpolation in the template passes through the escape layer,
 *     defending against future type-relaxation refactors that could
 *     silently open an injection vector.
 *
 * @param s - String to escape.
 * @returns HTML-safe version of `s` suitable for attribute-value and
 *   element-content interpolation.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
