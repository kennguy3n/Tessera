/**
 * Validates and normalises a user-controlled URL value before it is
 * interpolated into an `href` (or any other navigable URL attribute) of an
 * HTML fragment that flows through `dangerouslySetInnerHTML` or out via
 * an HTML export.
 *
 * Why this exists: the LandingPage and Infographic editors persist URLs
 * authored by the user (e.g. `hero.ctaUrl`, `cta.buttonUrl`). The JSON is
 * editable — manually, via re-import, or by a future API caller — and a
 * value such as
 *
 *     "javascript:alert(document.cookie)"
 *
 * would produce an XSS link in the live preview (`dangerouslySetInnerHTML`)
 * and propagate into any exported HTML. HTML-escaping is not sufficient
 * here — `escapeHtml()` does not strip the `javascript:` scheme; it only
 * escapes characters that would close the surrounding attribute. We must
 * validate the URL against an allowlist of safe schemes and fall back to a
 * neutral placeholder when validation fails.
 *
 * Accepted forms:
 *   - Absolute URLs with scheme `http:`, `https:`, `mailto:`, `tel:`
 *   - In-page anchors starting with `#`
 *   - Relative paths starting with `/`, `./`, or `../`
 *   - Schemeless network-relative URLs starting with `//`
 *   - Bare paths that do NOT contain a `:` before the first `/`, `#`, or
 *     `?` (treated as relative)
 *
 * Anything else (including `javascript:`, `data:`, `vbscript:`, `file:`,
 * `chrome:`, etc.) returns the caller-supplied fallback. The validator
 * deliberately strips leading/trailing ASCII whitespace and control
 * characters before scheme detection — `javascript: alert(1)` and
 * `\tjavascript:alert(1)` are both rejected.
 */

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

// ASCII whitespace and control characters that browsers strip when parsing
// the `href` attribute. We strip them ourselves before scheme detection so
// `\u0001\u0001javascript:alert(1)` cannot smuggle through. RFC 3986
// allows none of these inside a URL. The control chars are the *payload*
// of the regex — this is exactly the class browsers strip from `href`
// before scheme parsing — so the rule must be disabled for this line.
// eslint-disable-next-line no-control-regex
const STRIPPED_RE = /[\x00-\x20\u007F]/g;

export function sanitizeUrl(value: unknown, fallback: string = "#"): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(STRIPPED_RE, "");
  if (cleaned.length === 0) return fallback;
  if (cleaned.length > 2048) return fallback;

  // In-page anchor — always safe.
  if (cleaned.startsWith("#")) return cleaned;

  // Network-relative / protocol-relative — inherits the page scheme, which
  // in our exports is always `file:` or `https:`.
  if (cleaned.startsWith("//")) return cleaned;

  // Relative path / current-directory path.
  if (
    cleaned.startsWith("/") ||
    cleaned.startsWith("./") ||
    cleaned.startsWith("../")
  ) {
    return cleaned;
  }

  // Look for a scheme. If there's no colon before the first `/`, `#`, or
  // `?`, treat the value as a relative path (e.g. `pricing` or
  // `signup?ref=x`).
  const colon = cleaned.indexOf(":");
  if (colon === -1) return cleaned;
  const earliestPathSep = Math.min(
    ...["/", "#", "?"]
      .map((c) => cleaned.indexOf(c))
      .filter((i) => i >= 0)
      .concat([cleaned.length]),
  );
  if (colon > earliestPathSep) {
    // The `:` is part of the path/query/fragment, not a scheme separator.
    return cleaned;
  }

  const scheme = cleaned.slice(0, colon + 1).toLowerCase();
  if (SAFE_SCHEMES.has(scheme)) return cleaned;

  return fallback;
}
