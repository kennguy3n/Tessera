/**
 * Shared hero-image type + sanitizer used by `InfographicEditor` and
 * `LandingPageEditor`.
 *
 * Why this lives here
 * -------------------
 * Both editors persist an optional generated hero image alongside
 * their main content (so the preview can re-render on load without
 * re-running `tessera.imagegen.generate`). The persisted shape is
 * identical — `{ assetUrl, prompt, seed, width, height }` — and the
 * validation needed when reading user-edited JSON off disk is the
 * same in both editors:
 *
 *   - reject when `assetUrl` is not a string that starts with
 *     `tessera-asset://` (so a hostile artifact JSON can't inject an
 *     `http://evil.example.com/...` URL that the CSP would block at
 *     load time but better-caught at parse time);
 *   - reject when `prompt` / `seed` / `width` / `height` are missing
 *     or the wrong type (so the editor can never render a half-formed
 *     hero image).
 *
 * Devin Review pass-2 📝 finding on `LandingPageEditor.tsx:186-208`
 * pointed out that the two editors had byte-identical copies of the
 * function. Extracting it here removes the drift surface — a future
 * change to the validation rules (e.g. tightening to require
 * `seed >= 0`) now only needs to happen once.
 */

/**
 * Persisted hero image. The on-disk `path` is intentionally NOT
 * stored here — paths under `<userData>` differ across machines, so
 * a synced artifact must reference its image via the
 * `tessera-asset://...` URL the main process can resolve back to the
 * local on-disk path via the asset protocol handler.
 */
export interface HeroImage {
  assetUrl: string;
  prompt: string;
  seed: number;
  width: number;
  height: number;
}

/**
 * Validate a parsed `heroImage` payload from on-disk JSON.
 * Returns `undefined` when the payload is incomplete or the
 * `assetUrl` is not a `tessera-asset://` URL — the caller (the
 * editor's parse path) treats `undefined` as "no hero image set"
 * and surfaces the Generate UI again so the user can regenerate
 * cleanly.
 *
 * The `tessera-asset://` prefix check is a defence-in-depth alongside
 * the CSP `img-src` allowlist — if a user hand-edits an artifact
 * JSON to inject a remote URL, this rejects the entire payload at
 * parse time rather than letting it through and relying on the CSP
 * to block the network fetch at render time.
 */
export function sanitizeHeroImage(raw: unknown): HeroImage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.assetUrl !== "string" ||
    !r.assetUrl.startsWith("tessera-asset://") ||
    typeof r.prompt !== "string" ||
    typeof r.seed !== "number" ||
    typeof r.width !== "number" ||
    typeof r.height !== "number"
  ) {
    return undefined;
  }
  return {
    assetUrl: r.assetUrl,
    prompt: r.prompt,
    seed: r.seed,
    width: r.width,
    height: r.height,
  };
}
