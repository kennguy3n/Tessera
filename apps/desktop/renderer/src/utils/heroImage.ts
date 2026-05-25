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
 *     `tessera-asset://generated-images/` (the stricter prefix mirrors
 *     the single permitted host the main-process protocol handler at
 *     `apps/desktop/electron/assetProtocol.ts:174-189` will actually
 *     serve — every other host returns 403). This rejects both the
 *     outer `http://evil.example.com/...` CSP-bypass attempt AND the
 *     in-scheme `tessera-asset://evil-host/...` injection that would
 *     otherwise pass the sanitizer but get 403'd at render time. The
 *     module-level docstring was tightened from the earlier "starts
 *     with `tessera-asset://`" wording in the same pass that
 *     tightened the code check (Devin Review PR #38
 *     `BUG_pr-review-job-07d6d965…_0001`) — keeping both in sync is
 *     load-bearing because a reader who skims the module header
 *     should not underestimate the strictness of the validation.
 *     See the function-level docstring on `sanitizeHeroImage` for
 *     the full chain of layered defences;
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
 * `assetUrl` is not a `tessera-asset://generated-images/...` URL —
 * the caller (the editor's parse path) treats `undefined` as
 * "no hero image set" and surfaces the Generate UI again so the
 * user can regenerate cleanly.
 *
 * The `tessera-asset://generated-images/` prefix check is a
 * defence-in-depth alongside the CSP `img-src` allowlist AND the
 * main-process `assetProtocol.ts` host allow-list. It mirrors the
 * single permitted host (`generated-images`) the protocol handler
 * serves — see `apps/desktop/electron/assetProtocol.ts:174-189`,
 * where the handler returns 403 for any URL whose host is not
 * `generated-images`. Without matching the host portion of the
 * URL at parse time, a hand-edited artifact JSON containing
 * `"assetUrl": "tessera-asset://evil-host/img.png"` would pass
 * the sanitizer, get dropped into `<img src>` in both editors,
 * and the protocol handler would 403 the request — the user
 * would see a broken image with no path to recovery. By
 * rejecting the URL at parse time we surface the Generate UI
 * again so they can produce a fresh, well-formed hero image.
 *
 * The earlier-pass check on the scheme alone also rejected a
 * hostile `http://evil.example.com/...` injection (the CSP
 * `img-src` allowlist is the outer defence); tightening to the
 * host segment closes the in-scheme variant of the same attack.
 * Devin Review PR #38 pass-N 🚩 finding
 * `BUG_pr-review-job-07d6d965…_0001`.
 */
export function sanitizeHeroImage(raw: unknown): HeroImage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.assetUrl !== "string" ||
    !r.assetUrl.startsWith("tessera-asset://generated-images/") ||
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
