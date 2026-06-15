/**
 * Pure helpers for the Base editor's local-model AI assistant.
 *
 * Everything here is side-effect-free and React-free: prompt builders
 * that turn editor state into a single text prompt, and parsers /
 * validators that turn the model's free-text completion back into
 * typed, *validated* editor structures. The component layer
 * (`BaseAiAssistant.tsx`) owns the streaming/cancel plumbing and calls
 * these to build the request and interpret the result.
 *
 * ## Why a hard parse/validate boundary
 * A local language model is non-deterministic and will occasionally
 * emit prose around its JSON, hallucinate an unsupported field type,
 * or propose a formula that references a non-existent column. NONE of
 * that may reach the document: every parser below returns a
 * discriminated `{ ok: true, ... } | { ok: false, error }` result and
 * rejects anything it can't fully validate. The UI surfaces the error
 * and never mutates state on a failed parse.
 *
 * ## Privacy
 * Prompts are assembled locally and sent ONLY to the on-device model
 * via `window.tessera.model.generate`. No network AI, no third-party
 * calls. Callers must not log prompt or completion content.
 */
import type { BaseField, BaseRecord, FieldType } from "./baseEditorTypes";
import { isReservedFieldName } from "./baseEditorHelpers";

// ──────────────────────────────────────────────────────────────────────
// Result type
// ──────────────────────────────────────────────────────────────────────

export type AiParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// ──────────────────────────────────────────────────────────────────────
// Field-type whitelist for AI-generated schemas
// ──────────────────────────────────────────────────────────────────────

/**
 * Field types the assistant is allowed to emit when generating a
 * schema from a prompt. Deliberately excludes the types that need
 * extra wiring a prompt can't safely supply — `formula` (needs a
 * validated expression), `linked_record` / `rollup` / `lookup` (need a
 * target table + field), `auto_number` (editor-managed), and the
 * computed metadata types (`created_time` / `modified_time`). `user`
 * is allowed (free-text collaborator name).
 */
export const AI_SCHEMA_FIELD_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(
  [
    "text",
    "long_text",
    "number",
    "currency",
    "percent",
    "rating",
    "date",
    "checkbox",
    "select",
    "multi_select",
    "url",
    "email",
    "phone",
    "duration",
    "user",
  ],
);

/**
 * Map the loose type strings a model tends to produce onto our
 * canonical {@link FieldType}s. Returns `null` for anything we don't
 * recognise so the caller can fall back to `text` rather than trust an
 * unknown type.
 */
export function normalizeAiFieldType(raw: unknown): FieldType | null {
  if (typeof raw !== "string") return null;
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const alias: Record<string, FieldType> = {
    text: "text",
    string: "text",
    title: "text",
    name: "text",
    long_text: "long_text",
    longtext: "long_text",
    multiline: "long_text",
    notes: "long_text",
    description: "long_text",
    number: "number",
    integer: "number",
    int: "number",
    float: "number",
    decimal: "number",
    currency: "currency",
    money: "currency",
    price: "currency",
    percent: "percent",
    percentage: "percent",
    rating: "rating",
    stars: "rating",
    date: "date",
    datetime: "date",
    time: "date",
    checkbox: "checkbox",
    boolean: "checkbox",
    bool: "checkbox",
    select: "select",
    single_select: "select",
    singleselect: "select",
    dropdown: "select",
    enum: "select",
    category: "select",
    multi_select: "multi_select",
    multiselect: "multi_select",
    multiple_select: "multi_select",
    tags: "multi_select",
    labels: "multi_select",
    url: "url",
    link: "url",
    website: "url",
    email: "email",
    phone: "phone",
    tel: "phone",
    telephone: "phone",
    duration: "duration",
    user: "user",
    person: "user",
    collaborator: "user",
    assignee: "user",
    owner: "user",
  };
  const mapped = alias[key];
  return mapped && AI_SCHEMA_FIELD_TYPES.has(mapped) ? mapped : null;
}

// ──────────────────────────────────────────────────────────────────────
// JSON extraction
// ──────────────────────────────────────────────────────────────────────

/**
 * Pull the first *parseable* balanced JSON value (object or array) out
 * of a free-text completion, tolerating ```json fences and surrounding
 * prose. Returns the parsed value or `null` when none is present. Uses
 * brace/bracket balancing (respecting string literals and escapes)
 * rather than a greedy regex so trailing prose after the JSON doesn't
 * break the parse.
 *
 * If the first balanced candidate isn't valid JSON (e.g. the model
 * wrote prose containing `{ ... }` before the real payload), the scan
 * resumes at the next bracket rather than giving up — models don't
 * always honour the "emit ONLY JSON" instruction, and the cost of a
 * second attempt is negligible.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string") return null;
  // Strip ```json / ``` fences if present — the body is still
  // balanced-scanned below, so a missing closing fence is fine.
  const unfenced = text.replace(/```(?:json)?/gi, "");
  // Scan for successive bracket-opened candidates. `searchFrom` only
  // ever advances (past each opening bracket we try), so this is linear
  // in the number of candidates and always terminates.
  for (let searchFrom = 0; searchFrom < unfenced.length; ) {
    const rel = unfenced.slice(searchFrom).search(/[[{]/);
    if (rel === -1) return null;
    const start = searchFrom + rel;
    const open = unfenced[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let parsed: unknown = undefined;
    let resolved = false;
    for (let i = start; i < unfenced.length; i++) {
      const ch = unfenced[i];
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === open) {
        depth++;
      } else if (ch === close) {
        depth--;
        if (depth === 0) {
          const slice = unfenced.slice(start, i + 1);
          try {
            parsed = JSON.parse(slice);
            resolved = true;
          } catch {
            // This balanced candidate wasn't valid JSON; fall through
            // to resume scanning after this opening bracket.
          }
          break;
        }
      }
    }
    if (resolved) return parsed;
    // Either the candidate failed to parse, or it never balanced to EOF;
    // either way, look for the next bracket after this opening one.
    searchFrom = start + 1;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// 1. Schema generation
// ──────────────────────────────────────────────────────────────────────

export interface AiSchemaSuggestion {
  tableName: string;
  fields: BaseField[];
}

export function buildSchemaPrompt(description: string): string {
  const types = Array.from(AI_SCHEMA_FIELD_TYPES).join(", ");
  return [
    "You design database table schemas. Given a description, respond with",
    "ONLY a JSON object (no prose, no markdown fences) of the form:",
    '{"tableName": string, "fields": [{"name": string, "type": string, "options"?: string[]}]}',
    "",
    `Allowed field types: ${types}.`,
    "Use 'select' or 'multi_select' for categorical fields and include an",
    "'options' array of 3-7 example choices for those. Keep field names",
    "short (1-3 words), human-readable, and unique. Produce 3-8 fields.",
    "Do not include an id, formula, lookup, rollup, or linked-record field.",
    "",
    `Description: ${description.trim()}`,
  ].join("\n");
}

/**
 * Parse + validate a schema completion. Drops unknown types down to
 * `text`, dedupes field names case-insensitively, strips reserved
 * names, and enforces select/multi_select option hygiene. Fails only
 * when there is no usable JSON or zero valid fields.
 */
export function parseSchemaResponse(
  text: string,
): AiParseResult<AiSchemaSuggestion> {
  const json = extractJson(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, error: "The model did not return a table schema." };
  }
  const obj = json as { tableName?: unknown; fields?: unknown };
  const rawFields = Array.isArray(obj.fields) ? obj.fields : [];
  const fields: BaseField[] = [];
  const seen = new Set<string>();
  for (const rf of rawFields) {
    if (!rf || typeof rf !== "object" || Array.isArray(rf)) continue;
    const entry = rf as { name?: unknown; type?: unknown; options?: unknown };
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name === "") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (isReservedFieldName(name)) continue;
    seen.add(key);
    const type = normalizeAiFieldType(entry.type) ?? "text";
    const field: BaseField = { name, type };
    if (type === "select" || type === "multi_select") {
      const opts = Array.isArray(entry.options)
        ? entry.options
            .filter((o): o is string => typeof o === "string")
            .map((o) => o.trim())
            .filter((o) => o !== "")
        : [];
      // Dedupe options while preserving order.
      field.options = Array.from(new Set(opts));
    }
    fields.push(field);
  }
  if (fields.length === 0) {
    return {
      ok: false,
      error: "The model's schema had no usable fields.",
    };
  }
  const tableName =
    typeof obj.tableName === "string" && obj.tableName.trim() !== ""
      ? obj.tableName.trim()
      : "Table";
  return { ok: true, value: { tableName, fields } };
}

/** Match a Markdown heading line (`## TableName`) of any level. */
const SCHEMA_HEADING_RE = /^\s*#{1,6}\s+(.+?)\s*$/;
/** Match a `- field name: type` (or `*` / `•`) schema field line. */
const SCHEMA_FIELD_RE = /^\s*[-*•]\s*(.+?)\s*:\s*(.+?)\s*$/;

/**
 * Resolve the field type for a skill-emitted `- name: type` line.
 *
 * A relationship type — `link → OtherTable`, `link -> X`, or a bare
 * `link` — is materialised as `text`: the editor can't safely create a
 * real `linked_record` from a prompt because the target table doesn't
 * exist yet (and `linked_record` is excluded from the AI whitelist for
 * exactly that reason), so the column is created as plain text the user
 * can convert to a link afterwards. Everything else flows through
 * {@link normalizeAiFieldType}, falling back to `text` for anything
 * unrecognised — identical to {@link parseSchemaResponse}.
 */
function resolveSkillFieldType(raw: string): FieldType {
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith("link") || lower.includes("→") || lower.includes("->")) {
    return "text";
  }
  return normalizeAiFieldType(raw) ?? "text";
}

/**
 * Parse the Markdown schema a deliberate Base *skill* emits — one
 * `## TableName` heading per table, each followed by `- field_name:
 * type` lines — into one validated {@link AiSchemaSuggestion} per
 * table.
 *
 * Unlike {@link parseSchemaResponse} (which consumes the single-shot
 * JSON prompt's output), the skill's final step is documented to emit
 * this human-readable structure, so the apply path parses it directly
 * rather than forcing the small model back into brittle JSON.
 *
 * The SAME safety rules apply: unknown types fall back to `text`, field
 * names are deduped case-insensitively within a table, reserved names
 * are dropped, and `select`/`multi_select` fields start with an empty
 * option list (the skill format carries no inline options). Tables with
 * no usable fields are skipped; the parse fails only when no table with
 * at least one field can be recovered, so a bad completion can never
 * silently create empty tables.
 */
export function parseSchemaMarkdown(
  text: string,
): AiParseResult<AiSchemaSuggestion[]> {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, error: "The skill returned no schema." };
  }
  // Strip code fences a model may wrap the schema in, keeping inner text.
  const cleaned = text.replace(/```[a-zA-Z]*/g, "").replace(/```/g, "");
  const lines = cleaned.split(/\r?\n/);

  const tables: AiSchemaSuggestion[] = [];
  let current: {
    tableName: string;
    fields: BaseField[];
    seen: Set<string>;
  } | null = null;

  const flush = () => {
    if (current && current.fields.length > 0) {
      tables.push({ tableName: current.tableName, fields: current.fields });
    }
  };

  for (const rawLine of lines) {
    const heading = SCHEMA_HEADING_RE.exec(rawLine);
    if (heading) {
      flush();
      const name = heading[1].trim();
      current = {
        tableName: name === "" ? "Table" : name,
        fields: [],
        seen: new Set(),
      };
      continue;
    }
    if (!current) continue;
    const field = SCHEMA_FIELD_RE.exec(rawLine);
    if (!field) continue;
    const name = field[1].trim();
    if (name === "") continue;
    const key = name.toLowerCase();
    if (current.seen.has(key)) continue;
    if (isReservedFieldName(name)) continue;
    current.seen.add(key);
    const type = resolveSkillFieldType(field[2]);
    const entry: BaseField = { name, type };
    if (type === "select" || type === "multi_select") {
      entry.options = [];
    }
    current.fields.push(entry);
  }
  flush();

  if (tables.length === 0) {
    return { ok: false, error: "The skill's schema had no usable tables." };
  }
  return { ok: true, value: tables };
}

// ──────────────────────────────────────────────────────────────────────
// 2. NL → formula
// ──────────────────────────────────────────────────────────────────────

export function buildFormulaPrompt(
  instruction: string,
  fields: BaseField[],
): string {
  const fieldList = fields
    .filter((f) => f.type !== "formula")
    .map((f) => `{${f.name}} (${f.type})`)
    .join(", ");
  return [
    "You write spreadsheet-style formulas for a database field.",
    "Reference other fields with curly braces, e.g. {Price} * {Quantity}.",
    "Supported functions: IF, AND, OR, NOT, CONCAT, SUM, ROUND, ABS,",
    "MIN, MAX, LEN, UPPER, LOWER, TRIM. String literals use double quotes.",
    "Respond with ONLY the formula expression on a single line — no prose,",
    "no markdown, no leading '=' sign.",
    "",
    `Available fields: ${fieldList || "(none)"}.`,
    `Request: ${instruction.trim()}`,
  ].join("\n");
}

/**
 * Extract a single formula expression from a completion. Strips code
 * fences, a leading `=`, and surrounding whitespace/quotes. Returns
 * the first non-empty line (formulas are single-line in this engine).
 * Validation that the formula actually evaluates is done by the caller
 * via the existing formula engine, because that needs live fields.
 */
export function parseFormulaResponse(text: string): AiParseResult<string> {
  if (typeof text !== "string") {
    return { ok: false, error: "Empty formula response." };
  }
  const cleaned = text
    .replace(/```[a-z]*/gi, "")
    .replace(/```/g, "")
    .trim();
  const firstLine =
    cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  const expr = firstLine.replace(/^=+/, "").trim();
  if (expr === "") {
    return { ok: false, error: "The model did not return a formula." };
  }
  return { ok: true, value: expr };
}

// ──────────────────────────────────────────────────────────────────────
// 3. Column fill / enrich (row-wise)
// ──────────────────────────────────────────────────────────────────────

/** Compact a record down to the source fields the fill should read,
 *  skipping the target field and empty values. */
export function recordContext(
  record: BaseRecord,
  sourceFields: BaseField[],
): string {
  const parts: string[] = [];
  for (const f of sourceFields) {
    const v = record[f.name];
    if (v == null || v === "") continue;
    const text = Array.isArray(v) ? v.join(", ") : String(v);
    if (text.trim() === "") continue;
    parts.push(`${f.name}: ${text}`);
  }
  return parts.join("\n");
}

export function buildFillPrompt(
  instruction: string,
  target: BaseField,
  sourceFields: BaseField[],
  record: BaseRecord,
): string {
  const ctx = recordContext(record, sourceFields);
  const typeHint = fillTypeHint(target);
  return [
    `Fill the "${target.name}" field for one record.`,
    instruction.trim() ? `Instruction: ${instruction.trim()}` : "",
    typeHint,
    "",
    "Record:",
    ctx || "(no other fields populated)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Build the type-specific instruction appended to a fill prompt so the
 *  model returns a value `parseFillResponse` can coerce losslessly. */
function fillTypeHint(target: BaseField): string {
  switch (target.type) {
    case "number":
    case "currency":
    case "percent":
    case "rating":
      return "Respond with ONLY a number.";
    case "duration":
      return "Respond with ONLY a duration as h:mm (e.g. 1:30) or a whole number of minutes.";
    case "select":
      return target.options?.length
        ? `Respond with ONLY one of: ${target.options.join(", ")}.`
        : "Respond with ONLY the value, no prose, no labels.";
    case "multi_select":
      return target.options?.length
        ? `Respond with one or more of: ${target.options.join(", ")} — separated by commas.`
        : "Respond with one or more comma-separated values, no prose, no labels.";
    case "checkbox":
      // Pair with the strict yes/no word-list `parseFillResponse` accepts
      // for checkboxes — without this the model free-forms ("checked",
      // "✓", prose) and every row fails to parse.
      return "Respond with ONLY yes or no.";
    default:
      return "Respond with ONLY the value, no prose, no labels.";
  }
}

/**
 * Coerce a fill completion into a value appropriate for the target
 * field's type. Numbers are extracted from the text; selects are
 * snapped to an existing option (case-insensitive) or rejected;
 * multi-selects parse a comma/semicolon list (each token snapped to an
 * option when the field is constrained) into a `string[]`; durations
 * accept h:mm or a minutes count; checkboxes map truthy words to
 * booleans. Everything else trims to a single line of text.
 */
export function parseFillResponse(
  text: string,
  target: BaseField,
): AiParseResult<unknown> {
  if (typeof text !== "string") {
    return { ok: false, error: "Empty response." };
  }
  const cleaned = text
    .replace(/```[a-z]*/gi, "")
    .replace(/```/g, "")
    .trim();
  const firstLine =
    cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  if (firstLine === "") {
    return { ok: false, error: "The model returned no value." };
  }
  switch (target.type) {
    case "number":
    case "currency":
    case "percent":
    case "rating": {
      const m = firstLine.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      if (!m) return { ok: false, error: "Expected a number." };
      return { ok: true, value: Number(m[0]) };
    }
    case "duration": {
      // Durations are stored as integer minutes but render as h:mm, and
      // the model (like a user typing into DurationCell) may answer in
      // either form. Parse h:mm FIRST so "1:30" becomes 90 rather than
      // the bare-number branch extracting just the leading "1".
      const hm = firstLine.match(/^(\d+):([0-5]?\d)$/);
      if (hm) {
        return { ok: true, value: Number(hm[1]) * 60 + Number(hm[2]) };
      }
      const m = firstLine.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
      if (!m) return { ok: false, error: "Expected a duration." };
      return { ok: true, value: Number(m[0]) };
    }
    case "checkbox": {
      const truthy = /^(true|yes|y|1|x|on|done|complete)$/i.test(firstLine);
      const falsy = /^(false|no|n|0|off|incomplete)$/i.test(firstLine);
      if (!truthy && !falsy) {
        return { ok: false, error: "Expected yes/no." };
      }
      return { ok: true, value: truthy };
    }
    case "select": {
      const opts = target.options ?? [];
      if (opts.length > 0) {
        const match = opts.find(
          (o) => o.toLowerCase() === firstLine.toLowerCase(),
        );
        if (!match) {
          return {
            ok: false,
            error: `"${firstLine}" is not one of the field's options.`,
          };
        }
        return { ok: true, value: match };
      }
      return { ok: true, value: firstLine };
    }
    case "multi_select": {
      // multi_select values are stored as a `string[]`; returning the
      // raw line as a plain string here silently drops the value when
      // MultiSelectCell does `Array.isArray(value)`. Split the model's
      // comma/semicolon list, snap each token to an existing option
      // (case-insensitive) when the field is constrained, and dedupe.
      const tokens = firstLine
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter((t) => t !== "");
      if (tokens.length === 0) {
        return { ok: false, error: "The model returned no value." };
      }
      const opts = target.options ?? [];
      const out: string[] = [];
      for (const tok of tokens) {
        if (opts.length > 0) {
          const match = opts.find((o) => o.toLowerCase() === tok.toLowerCase());
          if (!match) {
            return {
              ok: false,
              error: `"${tok}" is not one of the field's options.`,
            };
          }
          if (!out.includes(match)) out.push(match);
        } else if (!out.includes(tok)) {
          out.push(tok);
        }
      }
      return { ok: true, value: out };
    }
    default:
      return { ok: true, value: firstLine };
  }
}

// ──────────────────────────────────────────────────────────────────────
// 4. Summarize a selection
// ──────────────────────────────────────────────────────────────────────

export function buildSummarizePrompt(
  records: BaseRecord[],
  fields: BaseField[],
  instruction = "",
): string {
  const visible = fields.filter(
    (f) =>
      f.type !== "attachment" &&
      f.type !== "formula" &&
      f.type !== "linked_record",
  );
  const rows = records
    .slice(0, 50)
    .map((r, i) => `${i + 1}. ${recordContext(r, visible)}`)
    .join("\n");
  return [
    "Summarize the following records in 2-4 sentences of plain prose.",
    instruction.trim() ? `Focus: ${instruction.trim()}` : "",
    "",
    rows || "(no records)",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Trim a free-text summary completion (strip fences/whitespace). */
export function parseTextResponse(text: string): AiParseResult<string> {
  if (typeof text !== "string") {
    return { ok: false, error: "Empty response." };
  }
  const cleaned = text
    .replace(/```[a-z]*/gi, "")
    .replace(/```/g, "")
    .trim();
  if (cleaned === "") {
    return { ok: false, error: "The model returned nothing." };
  }
  return { ok: true, value: cleaned };
}
