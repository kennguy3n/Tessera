/**
 * Sanitised inline-typography extensions.
 *
 * The stock `@tiptap/extension-text-style` children (`Color`, `FontFamily`,
 * `FontSize`) and `@tiptap/extension-highlight` all interpolate their stored
 * attribute straight into an inline `style` string, e.g.
 *
 *     renderHTML: (attrs) => ({ style: `color: ${attrs.color}` })
 *
 * The attribute round-trips through the saved document, so a crafted artifact
 * — `color: red; background: url(https://evil/pixel)` — would emit extra CSS
 * declarations when rendered. In a multi-tenant deployment that is an
 * injection / privacy-leak vector the moment a document authored by one tenant
 * is opened by another (a `url(...)` background beacons on open).
 *
 * Browsers split a parsed `style` attribute into individual properties, so the
 * `parseHTML` path is mostly safe on its own; the real exposure is the
 * `renderHTML` path, which re-emits whatever value sits on the node — including
 * values injected directly into stored ProseMirror JSON, bypassing HTML
 * parsing. We therefore re-declare each attribute with the same shape but
 * validate the value against a strict allow-list on BOTH read and write, and
 * drop anything outside the grammar rather than serialising it. Every
 * legitimate toolbar preset (hex colours, `16px`, `Inter, system-ui,
 * sans-serif`) passes unchanged.
 */
import { Color, FontFamily, FontSize } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";

const MAX_LEN = 128;

// `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// `rgb()` / `rgba()` / `hsl()` / `hsla()`. The inner characters are limited to
// the numeric grammar (digits, separators, units) so no `url(`, identifier or
// `;` can be smuggled inside the parentheses.
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%/\sdeg]+\)$/i;
// Bare CSS keyword colours (`red`, `transparent`, `currentcolor`, …). Letters
// only, so it cannot contain a separator or `url`.
const COLOR_KEYWORD = /^[a-z]+$/i;

/** A safe CSS colour: hex, an `rgb/hsl(...)` function, or a bare keyword. */
export function isSafeCssColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s === "" || s.length > MAX_LEN) return false;
  return HEX.test(s) || COLOR_FN.test(s) || COLOR_KEYWORD.test(s);
}

// A number with an allow-listed unit, e.g. `16px`, `1.5em`, `120%`.
const FONT_SIZE = /^\d+(?:\.\d+)?(?:px|em|rem|pt|%)$/;

/** A safe `font-size`: a non-negative number with an allow-listed unit. */
export function isSafeFontSize(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return s.length <= 16 && FONT_SIZE.test(s);
}

// A font-family list: names, quotes, commas, spaces, hyphens. No structural CSS
// characters (`;`, `:`, `(`, `)`, `{`, `}`) so it can neither break out of the
// declaration nor invoke `url(...)`.
const FONT_FAMILY = /^[\w\s,'"-]+$/;

/** A safe `font-family` list: name tokens, quotes, commas and spaces only. */
export function isSafeFontFamily(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return s !== "" && s.length <= MAX_LEN && FONT_FAMILY.test(s);
}

/** `Color` that only ever serialises an allow-listed CSS colour. */
export const SafeColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (element) => {
              const raw = element.style.color?.replace(/['"]+/g, "");
              return isSafeCssColor(raw) ? raw.trim() : null;
            },
            renderHTML: (attributes) => {
              const value = attributes.color as unknown;
              if (!isSafeCssColor(value)) return {};
              return { style: `color: ${value.trim()}` };
            },
          },
        },
      },
    ];
  },
});

/** `FontFamily` that only ever serialises an allow-listed family list. */
export const SafeFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) => {
              const raw = element.style.fontFamily;
              return isSafeFontFamily(raw) ? raw.trim() : null;
            },
            renderHTML: (attributes) => {
              const value = attributes.fontFamily as unknown;
              if (!isSafeFontFamily(value)) return {};
              return { style: `font-family: ${value.trim()}` };
            },
          },
        },
      },
    ];
  },
});

/** `FontSize` that only ever serialises a number with an allow-listed unit. */
export const SafeFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => {
              const raw = element.style.fontSize;
              return isSafeFontSize(raw) ? raw.trim() : null;
            },
            renderHTML: (attributes) => {
              const value = attributes.fontSize as unknown;
              if (!isSafeFontSize(value)) return {};
              return { style: `font-size: ${value.trim()}` };
            },
          },
        },
      },
    ];
  },
});

/** `Highlight` (multicolor) that only ever serialises a safe CSS colour. */
export const SafeHighlight = Highlight.extend({
  addAttributes() {
    if (!this.options.multicolor) return {};
    return {
      color: {
        default: null,
        parseHTML: (element) => {
          const raw =
            element.getAttribute("data-color") || element.style.backgroundColor;
          return isSafeCssColor(raw) ? raw.trim() : null;
        },
        renderHTML: (attributes) => {
          const value = attributes.color as unknown;
          if (!isSafeCssColor(value)) return {};
          const safe = value.trim();
          return {
            "data-color": safe,
            style: `background-color: ${safe}; color: inherit`,
          };
        },
      },
    };
  },
});
