/**
 * Validates a user-controlled icon spec ("set:name") before it is
 * interpolated into an `{{icon:...}}` token in the infographic / landing-page
 * preview HTML.
 *
 * Why this exists: `buildPreviewHtml` and `buildLandingPreviewHtml` emit
 * `{{icon:${spec} size=N color=...}}` and then run `embedIcons()` over the
 * result. `embedIcons` uses the regex `/\{\{icon:([a-zA-Z0-9_:\-+# .=]+)\}\}/g`
 * which only matches well-formed specs — but a malicious value such as
 *
 *     "}}<script>alert(1)//{{icon:lucide:x"
 *
 * causes the regex to fail to match the whole token, and the raw text
 * (including `<script>...</script>`) survives `embedIcons` and is then
 * injected into the DOM via `dangerouslySetInnerHTML`. HTML-escaping the
 * spec is not an option either: `embedIcons` runs AFTER any HTML escape and
 * would see the escaped `&amp;` etc. and fail to resolve. So we validate
 * the spec up-front against a strict grammar and fall back to "no icon"
 * (empty token) when the value does not parse.
 *
 * Accepted grammar:
 *
 *   spec  := set ":" name
 *   set   := "lucide" | "phosphor"
 *   name  := [a-z0-9](-?[a-z0-9])*   (kebab-case)
 *
 * The `set` allowlist mirrors what the IconPicker emits (`IconSet`), and
 * the `name` grammar mirrors the Lucide / Phosphor icon naming conventions
 * (lowercase kebab-case ASCII).
 */

const ICON_SET_ALLOWLIST = new Set(["lucide", "phosphor"]);

// Lucide / Phosphor icon names are emitted by `listIcons()` in PascalCase
// (e.g. `CheckCircle`, `TrendingUp`) and are also accepted in kebab-case by
// `lookupComponent` (e.g. `trending-up`). A few names start with digits
// (Lucide's `3d-printer`, `5g`) so we anchor on `[A-Za-z0-9]` rather than
// `[a-z]`. Underscores are permitted because `embedIcons`'s token regex
// already allows them, and a few legacy aliases use them.
const ICON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Return the spec verbatim if it is a safe `set:name` pair; otherwise
 * return `null`. Callers should treat `null` as "no icon" and emit an
 * empty token (or skip the icon span entirely).
 */
export function sanitizeIconSpec(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;

  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) return null;
  const set = trimmed.slice(0, colon);
  const name = trimmed.slice(colon + 1);
  if (!ICON_SET_ALLOWLIST.has(set)) return null;
  if (!ICON_NAME_RE.test(name)) return null;

  return `${set}:${name}`;
}
