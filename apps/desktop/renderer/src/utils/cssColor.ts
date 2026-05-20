/**
 * Validates and normalises a user-controlled CSS color value before it is
 * interpolated into an inline `style="..."` attribute or a CSS custom
 * property declaration.
 *
 * Why this exists: the infographic and landing-page editors persist color
 * values from `<input type="color">`. The native color picker always emits
 * `#rrggbb`, but the underlying JSON is editable (manually, via re-import,
 * or by a future API caller) and a malicious value such as
 *
 *     "red; background-image: url('javascript:alert(1)')"
 *
 * would escape the intended CSS-property slot once interpolated into a
 * style attribute. HTML-escaping is not sufficient here — `;` and `:` are
 * not HTML-special inside an attribute value, so escapeHtml() lets a CSS
 * payload through. We must validate the value against a CSS-color grammar
 * and fall back to a caller-provided default when validation fails.
 *
 * Accepted forms:
 *   - 3-, 4-, 6-, or 8-digit hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`)
 *   - `rgb(...)` and `rgba(...)` with numeric components only
 *   - `hsl(...)` and `hsla(...)` with numeric components only
 *   - The CSS keyword `transparent` and `currentColor`
 *   - A small allowlist of common CSS color keywords (for legacy data)
 *
 * Anything else returns the supplied fallback. The validator deliberately
 * rejects whitespace before/after the value, embedded comments, function
 * calls outside the rgb/rgba/hsl/hsla allow-list, and any character that
 * could close the surrounding `style="..."` attribute (`;`, `"`, `'`,
 * angle brackets).
 */

const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// Numeric component: optional sign, digits, optional decimal, optional %.
const NUM = "-?\\d+(?:\\.\\d+)?%?";
const RGB_RE = new RegExp(
  `^rgba?\\(\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*(?:,\\s*${NUM}\\s*)?\\)$`,
);
const HSL_RE = new RegExp(
  `^hsla?\\(\\s*${NUM}(?:deg|rad|grad|turn)?\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*(?:,\\s*${NUM}\\s*)?\\)$`,
);

const NAMED_KEYWORDS = new Set([
  "transparent",
  "currentcolor",
  // A small subset of common CSS named colors. We intentionally do NOT
  // import the full 147-name list here — the picker emits hex, and the
  // keywords below cover human-edited data without bloating the bundle.
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "cyan",
  "magenta",
  "gray",
  "grey",
  "orange",
  "purple",
  "pink",
  "brown",
]);

export function sanitizeCssColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return fallback;

  // Reject any character that could break out of an inline-style attribute
  // or open a CSS comment.  This is a belt-and-braces check; the grammar
  // checks below would already reject these.
  if (/[<>"';{}\\]|\/\*|\*\//.test(trimmed)) return fallback;

  if (HEX_RE.test(trimmed)) return trimmed;
  if (RGB_RE.test(trimmed)) return trimmed;
  if (HSL_RE.test(trimmed)) return trimmed;
  if (NAMED_KEYWORDS.has(trimmed.toLowerCase())) return trimmed;

  return fallback;
}
