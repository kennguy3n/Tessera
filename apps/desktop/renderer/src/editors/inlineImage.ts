// ─────────────────────────────────────────────────────────────────────
// Shared inline-image embed helper.
//
// The document editor and the slide editor both embed uploaded images
// inline as `data:image/...;base64,...` URLs into their saved JSON
// artifact. Embedding inline (rather than spilling to a separate
// asset store) is a deliberate choice for Tessera's self-contained
// JSON model: it keeps an artifact portable (export, version restore,
// copy/paste across machines) without a separate asset-store schema.
//
// The trade-off is artifact size — base64 encoding inflates payloads
// by ~33%, and `JSON.stringify` re-serialises the whole document on
// every debounced save. To keep saves snappy and to keep the artifact
// JSON small, we cap inline-embedded images at a soft 5 MiB ceiling
// and surface a human-readable error rather than silently embed a
// multi-megabyte data URL.
//
// Before this module existed, both editors hand-rolled their own
// `fileToDataUrl` and the slide
// editor's copy had no size cap at all Centralising the helper here keeps the size cap and
// the FileReader plumbing in one place so a future fix (e.g.
// recognising an empty `readAsDataURL` result on certain MIME types)
// only needs to land once.
// ─────────────────────────────────────────────────────────────────────

/**
 * Soft cap on the size of a file that may be embedded inline as a
 * base64 `data:` URL. Currently 5 MiB; tuned to keep `JSON.stringify`
 * of a typical artifact under ~10 MiB even after base64 inflation,
 * which is well within Electron renderer comfort.
 *
 * Documented as a public export so call sites can format their own
 * pre-upload validation messages against the same threshold.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Read a `File` (from a paste / drop / file-picker) as a `data:` URL
 * suitable for inline embedding in a saved artifact JSON. Rejects
 * with a human-readable error when:
 *
 *   - The file exceeds {@link MAX_INLINE_IMAGE_BYTES} — surfaced as
 *     `"Image is X.Y MiB; the inline-embed cap is N MiB."` so the
 *     caller can show the message verbatim in a toast.
 *   - The underlying `FileReader` errored (e.g. the user revoked
 *     access to a dropped file mid-read).
 *   - The reader resolved with a non-string `result` — `FileReader`'s
 *     `result` is typed `string | ArrayBuffer | null`; `readAsDataURL`
 *     always produces a string in practice but the type guard keeps
 *     the helper honest if a future caller swaps to `readAsArrayBuffer`.
 *
 * NOTE: This helper is intentionally `FileReader`-based (not a Node
 * `Buffer`/`fs` path) so it stays renderer-only and keeps working in
 * the existing jsdom-based vitest harness without a node:fs polyfill.
 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_INLINE_IMAGE_BYTES) {
      reject(
        new Error(
          `Image is ${(file.size / 1024 / 1024).toFixed(1)} MiB; the inline-embed cap is ${(
            MAX_INLINE_IMAGE_BYTES /
            1024 /
            1024
          ).toFixed(0)} MiB.`,
        ),
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader produced a non-string result"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}
