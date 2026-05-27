/**
 * Shared, pure-function helpers for working with `SourceInfo` values
 * across the renderer. Lives in `utils/` (rather than a page module)
 * so the list page (`SourcesPage.tsx`), the detail page
 * (`SourceDetailPage.tsx`), and any future surface (e.g. global
 * search, sidebar quick-pick) can import the same canonical
 * implementation without creating a cross-page module dependency.
 *
 * Phase 13 Theme 2 (Task 11 review-pass fix, ANALYSIS_0005 on
 * f7c8dd1): the helpers below used to live in `SourceDetailPage.tsx`
 * and `SourcesPage.tsx` imported them with
 *   `import { formatSourceTypeLabel } from "./SourceDetailPage";`
 * which (a) implicitly pulled the SourceDetailPage React component
 * tree into SourcesPage's module graph and (b) made the list page
 * structurally dependent on the detail page even though the two
 * surfaces are siblings. Extracting to `utils/sourceLabels.ts`
 * removes the cross-page coupling, makes the helpers trivially
 * unit-testable, and matches the pattern already used by
 * `utils/safeUrl.ts`, `utils/cssColor.ts`, etc.
 *
 * Both functions are pure: same input → same output, no side
 * effects, no dependencies on React or any IPC layer. Keep them
 * that way — if a future variant needs to reach into IPC state, add
 * a separate hook in `hooks/` instead of growing this module.
 */

import type { SourceInfo } from "../types/ipc";

/**
 * Extract the KChat channel id from a `SourceType::Kchat` source's
 * `path`. The Node-side `kchatChannelCacheDir(channelId)` always
 * produces `<home>/.tessera/kchat-channels/<channelId>`, so the
 * last path segment is the canonical channel id.
 *
 * Returns `null` for non-KChat sources OR when the basename is
 * empty (defensive guard against a malformed `source.path`). The
 * renderer treats `null` as "don't poll backfill state" — the
 * `useKchatBackfillProgress` hook is quiescent for `null`.
 *
 * Splits on BOTH `/` and `\` so the helper works on Windows where
 * `path.join(...)` in the main process produces backslash-separated
 * paths like `C:\Users\user\.tessera\kchat-channels\<id>` (Devin
 * Review on 869295e, BUG_0001). A POSIX-only split would yield a
 * single segment containing the full Windows path string, which
 * then fails the IPC's `assertKchatId` regex and the renderer would
 * silently never render a progress card on Windows.
 *
 * We intentionally do NOT re-validate the 26-char object-id shape
 * here. The IPC handler at `kchat:backfillProgress` re-validates
 * via `assertKchatId(channelId, "channelId")` so any malformed
 * input rejects at the boundary with a clear error message. The
 * renderer-side strict regex would just produce a silent UI no-op,
 * which is harder to debug than an IPC-level rejection that the
 * polling hook surfaces back as a transport error.
 */
export function extractKchatChannelIdFromSource(
  source: SourceInfo,
): string | null {
  if (source.sourceType !== "kchat") return null;
  const segments = source.path.split(/[\\/]/).filter((s) => s.length > 0);
  const id = segments[segments.length - 1];
  return id && id.length > 0 ? id : null;
}

/**
 * Render a human-readable label for a `SourceInfo.sourceType` so
 * the Source Information card (and any other surface that displays
 * the type) shows something coherent for every known kind.
 *
 * Phase 13 Task 10 fix (Devin Review on 869295e, ANALYSIS_0003): the
 * pre-Task-10 page only rendered local sources, so the card used a
 * binary `local_folder ? "Local Folder" : "Local File"` ternary.
 * Task 10 lit up the page for KChat sources too, which made the
 * fallthrough "Local File" label misleading. The helper centralises
 * the mapping so any future source kind only has to be added in
 * one place. Unknown / future kinds fall through to a humanised
 * version of the raw `sourceType` string so the UI degrades
 * gracefully instead of mis-attributing the kind.
 */
export function formatSourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case "local_folder":
      return "Local Folder";
    case "local_file":
      return "Local File";
    case "kchat":
      return "KChat Channel";
    default:
      // Humanise an unknown discriminator (`some_new_kind` →
      // `Some New Kind`) so a future variant looks reasonable
      // in the UI even before we land an explicit case here.
      return sourceType
        .split("_")
        .filter((s) => s.length > 0)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ");
  }
}

/**
 * Visual + accessibility metadata for a `SourceInfo.sourceType` so
 * the source-list and source-detail surfaces can mark each row with
 * a recognisable glyph at a glance (folder for filesystem trees,
 * page for individual files, chat bubble for KChat channels) without
 * polluting every consumer with the switch.
 *
 * Returns:
 *   - `glyph`: a short Unicode/emoji marker to render in the UI.
 *     Empty string for unknown kinds so callers can choose between
 *     "render no marker" (default) and "render a generic fallback"
 *     without re-implementing the policy.
 *   - `ariaLabel`: a short, screen-reader-friendly description of
 *     what the glyph represents (e.g. "Local folder source"). The
 *     glyph itself is decorative once the label is read aloud, so
 *     callers should wrap the glyph in a `<span role="img"
 *     aria-label={ariaLabel}>` and pair it with `aria-hidden="true"`
 *     on any inner glyph nodes if the structure demands it.
 *
 * Phase 13 Theme 5 Task 27: previously `SourcesPage` rendered every
 * source row with the same plain text title regardless of kind, so
 * a user scanning a long list could not distinguish a `local_folder`
 * source from a `kchat` channel without reading the description
 * line. The pre-Theme-5 `CitationPanel` already established the
 * convention that KChat-derived rows carry a visible chat-bubble
 * marker (`citation-source-badge-kchat`); this helper extends that
 * convention to the source-list and source-detail pages so the
 * KChat surface looks consistent across all three places.
 *
 * Glyphs are intentionally Unicode/emoji rather than SVG icons:
 *   1. The existing `fileTypeIcon` in `KchatChannelSourcePicker`
 *      already uses emoji glyphs (📄, 🖼️, etc.) so the visual
 *      vocabulary is consistent.
 *   2. Emoji glyphs render correctly on every platform without
 *      shipping additional icon assets or accessibility plumbing.
 *   3. Unknown kinds can fall through to an empty glyph without a
 *      broken-icon placeholder.
 */
export function sourceTypeIcon(sourceType: string): {
  glyph: string;
  ariaLabel: string;
} {
  switch (sourceType) {
    case "local_folder":
      return { glyph: "📁", ariaLabel: "Local folder source" };
    case "local_file":
      return { glyph: "📄", ariaLabel: "Local file source" };
    case "kchat":
      return { glyph: "💬", ariaLabel: "KChat channel source" };
    default:
      // Empty glyph — caller renders the row without a marker
      // rather than picking an arbitrary stand-in. The
      // `ariaLabel` still describes the kind so a future
      // consumer that DOES want a fallback glyph has a
      // human-readable string to attach.
      return {
        glyph: "",
        ariaLabel: `${formatSourceTypeLabel(sourceType)} source`,
      };
  }
}
