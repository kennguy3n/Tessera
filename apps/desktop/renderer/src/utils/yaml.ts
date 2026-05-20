/**
 * YAML scalar quoting helpers used to interpolate user-editable values into
 * the Marp front-matter block.
 *
 * Why this exists: Marp uses YAML for the per-deck directive block
 *
 *   ---
 *   marp: true
 *   theme: gaia
 *   class: lead
 *   ---
 *
 * which is parsed by the Marp CLI before the slides are rendered. The
 * `theme`, `backgroundColor`, and `class` (a.k.a. `klass`) values flow from
 * user-editable JSON; interpolating them unquoted into the YAML lets a
 * value containing a newline (e.g. `"gaia\nclass: lead"`) inject a second
 * directive. Single-quoted YAML scalars cannot contain a newline and only
 * need the apostrophe to be doubled — so quoting is the right long-term
 * fix and handles the entire class of injection issues uniformly.
 */

/**
 * Encode `value` as a YAML single-quoted scalar. The output is `'…'` with
 * every embedded apostrophe doubled. Newlines are stripped — a YAML single-
 * quoted scalar cannot legally carry a literal newline, so we drop them
 * rather than synthesising a multi-line scalar that downstream tools may
 * not support.
 */
export function yamlSingleQuote(value: string): string {
  const flat = value.replace(/[\r\n]+/g, " ").replace(/'/g, "''");
  return `'${flat}'`;
}
