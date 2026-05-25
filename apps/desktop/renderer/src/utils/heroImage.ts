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
 *     hero image);
 *   - reject when `seed` / `width` / `height` are `NaN` / `Infinity`
 *     (a hand-edited artifact JSON with `"width": 1e999` parses to
 *     `Infinity` and `typeof === 'number'` accepts it — using
 *     `Number.isFinite` closes the gap at parse time so downstream
 *     rendering never sees a non-finite dimension);
 *   - reject when `seed` is negative or beyond `Number.MAX_SAFE_INTEGER`,
 *     or when `width` / `height` are not positive integers (matches
 *     the upstream `imagegen:generate` IPC contract — seeds are
 *     non-negative u64 truncated to safe-int range, dimensions are
 *     positive integer pixel counts).
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
    typeof r.prompt !== "string"
  ) {
    return undefined;
  }
  // Seed: non-negative safe-integer (matches imagegen.generate output —
  // seeds are u64 truncated to Number.MAX_SAFE_INTEGER on the IPC
  // boundary, see apps/desktop/electron/ipc/imagegen.ts:bigint-coercion).
  // `Number.isSafeInteger` enforces the [-2^53+1, 2^53-1] safe-int range
  // AND rejects NaN/Infinity/non-integers in a single predicate. A plain
  // `Number.isInteger` would let 2^53 (= MAX_SAFE_INTEGER + 1) through —
  // 2^53 is exactly representable as a double and `isInteger` is `true`
  // for it — which would let a hand-edited artifact JSON with
  // `"seed": 9007199254740992` past the sanitizer even though the
  // upstream IPC contract truncates seeds AT `Number.MAX_SAFE_INTEGER`.
  if (
    typeof r.seed !== "number" ||
    !Number.isSafeInteger(r.seed) ||
    r.seed < 0
  ) {
    return undefined;
  }
  // Width / height: positive safe-integers. `Number.isSafeInteger` is
  // false for NaN / Infinity / non-integers / values above
  // MAX_SAFE_INTEGER (2^53-1), so combined with the `> 0` check it
  // rules out every non-pixel-count value AND stays consistent with
  // the seed check above. Plain `Number.isInteger` would let `2^53`
  // through (it's exactly representable as a double and is "integer"
  // by IEEE-754 lights), letting a hand-edited artifact JSON sneak a
  // dimension past the sanitizer that no realistic display could
  // render. The defence-in-depth argument that justifies the seed
  // safe-int gate applies symmetrically here.
  if (
    typeof r.width !== "number" ||
    !Number.isSafeInteger(r.width) ||
    r.width <= 0
  ) {
    return undefined;
  }
  if (
    typeof r.height !== "number" ||
    !Number.isSafeInteger(r.height) ||
    r.height <= 0
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
