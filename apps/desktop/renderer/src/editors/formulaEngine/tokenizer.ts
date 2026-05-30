/**
 * Phase 16 Task 1 — formula tokenizer.
 *
 * Streaming scanner over the source string. Produces the tokens the
 * parser consumes:
 *
 *   NUMBER         — `12`, `12.5`, `.5`, `1e3`, `1.2e-3` (no sign;
 *                    unary minus is a separate OPERATOR token)
 *   STRING         — `"hi"`, `"He said ""hi"""` (RFC-4180-style
 *                    doubled-quote escapes)
 *   BOOLEAN        — `TRUE` / `FALSE` (case-insensitive)
 *   CELL_REF       — `A1`, `$A$1`, `A$1`, `$A1` (absolute markers
 *                    captured for fill-down arithmetic in Phase 16
 *                    PR 3, but otherwise treated identically by the
 *                    evaluator)
 *   RANGE          — `A1:B5` (parser combines a CELL_REF + ':' +
 *                    CELL_REF; the tokenizer emits CELL_REF, COLON,
 *                    CELL_REF and lets the parser fuse them so we
 *                    don't have to look-ahead here)
 *   FUNCTION_NAME  — identifier followed by `(` (so `SUM` in
 *                    `=SUM(A1)` tokenizes as FUNCTION_NAME but `SUM`
 *                    not followed by `(` is a #NAME? at evaluation
 *                    time)
 *   IDENTIFIER     — bare names (named ranges, future cross-sheet
 *                    sheet-name segments)
 *   LPAREN/RPAREN  — `(` `)`
 *   COMMA          — `,`
 *   COLON          — `:` (range operator)
 *   OPERATOR       — `+`, `-`, `*`, `/`, `^`, `&`, `=`, `<>`, `<`,
 *                    `>`, `<=`, `>=`
 *   PERCENT        — `%` (post-fix operator, applied at parse time)
 *   EOF            — sentinel
 *   ERROR          — caller-visible scanner error (unterminated
 *                    string, illegal character); carried through to
 *                    the parser which turns it into `#ERR!`.
 *
 * The tokenizer is intentionally permissive about whitespace and
 * case — Excel's grammar allows `=sum( a1 : a3 )` and folds
 * `=sum(a1)` to upper-case at the function-lookup level. Function
 * names are uppercased here; cell references are uppercased too
 * (column letters in Excel are case-insensitive).
 *
 * Whitespace is consumed but not emitted (the parser doesn't care
 * where it appears).
 */

/** Discriminated-union token tag. */
export type TokenType =
  | "NUMBER"
  | "STRING"
  | "BOOLEAN"
  | "CELL_REF"
  | "FUNCTION_NAME"
  | "IDENTIFIER"
  /** `'Sheet With Spaces'` quoted sheet-name segment (Phase 16 Task 13). */
  | "SHEET_QUOTED"
  /** `!` separator between sheet name and cell reference. */
  | "BANG"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "COLON"
  | "OPERATOR"
  | "PERCENT"
  | "EOF"
  | "ERROR";

export interface Token {
  readonly type: TokenType;
  /** Raw source text the token was scanned from (for diagnostics). */
  readonly text: string;
  /** Pre-decoded payload for atoms (NUMBER/STRING/BOOLEAN). */
  readonly value?: number | string | boolean;
  /** Captured for CELL_REF; otherwise undefined. */
  readonly cellRef?: {
    readonly absoluteCol: boolean;
    readonly col: number; // zero-based
    readonly absoluteRow: boolean;
    readonly row: number; // zero-based
  };
  /** 0-based source position of the first character of the token. */
  readonly start: number;
  /** 0-based exclusive end position. */
  readonly end: number;
}

/**
 * Tokenize `input` (a single formula source string, with or without
 * the leading `=`) into a `Token[]` terminated by an EOF token.
 *
 * Errors are emitted as tokens with type `"ERROR"` and a diagnostic
 * `text` — the caller decides whether to fail the whole formula
 * (`#ERR!`) or continue scanning. The parser used by Tessera fails
 * the whole formula on the first ERROR token, which matches Excel's
 * behaviour.
 */
export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  // Strip the leading `=` if present; the caller (`Parser`) accepts
  // both forms so this is a convenience.
  let src = input;
  let baseOffset = 0;
  if (src.length > 0 && src[0] === "=") {
    src = src.slice(1);
    baseOffset = 1;
  }
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const absStart = baseOffset + i;
    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    // String literal
    if (ch === '"') {
      const literalStart = i;
      i++;
      let value = "";
      let terminated = false;
      while (i < src.length) {
        if (src[i] === '"') {
          if (i + 1 < src.length && src[i + 1] === '"') {
            // Escaped quote (RFC 4180 style)
            value += '"';
            i += 2;
          } else {
            i++;
            terminated = true;
            break;
          }
        } else {
          value += src[i];
          i++;
        }
      }
      if (!terminated) {
        tokens.push({
          type: "ERROR",
          text: src.slice(literalStart),
          start: baseOffset + literalStart,
          end: baseOffset + i,
        });
        return tokens;
      }
      tokens.push({
        type: "STRING",
        text: src.slice(literalStart, i),
        value,
        start: baseOffset + literalStart,
        end: baseOffset + i,
      });
      continue;
    }
    // Quoted sheet name — `'Sheet 1'`, `'My Sheet''s Data'`. Excel
    // requires single-quote wrapping for sheet names containing
    // characters illegal in an identifier (spaces, punctuation).
    // We emit a SHEET_QUOTED token containing the unwrapped /
    // un-doubled-quote name; the parser pairs it with the BANG +
    // CELL_REF that follow.
    if (ch === "'") {
      const literalStart = i;
      i++;
      let value = "";
      let terminated = false;
      while (i < src.length) {
        if (src[i] === "'") {
          if (i + 1 < src.length && src[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            i++;
            terminated = true;
            break;
          }
        } else {
          value += src[i];
          i++;
        }
      }
      if (!terminated) {
        tokens.push({
          type: "ERROR",
          text: src.slice(literalStart),
          start: baseOffset + literalStart,
          end: baseOffset + i,
        });
        return tokens;
      }
      tokens.push({
        type: "SHEET_QUOTED",
        text: src.slice(literalStart, i),
        value,
        start: baseOffset + literalStart,
        end: baseOffset + i,
      });
      continue;
    }
    // Sheet-name separator `!` — only legal between an identifier
    // (sheet name) and a cell reference. The parser checks the
    // surrounding tokens; the tokenizer just classifies.
    if (ch === "!") {
      tokens.push({ type: "BANG", text: "!", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    // Number literal — `12`, `12.5`, `.5`, `1e3`, `1.5E-3`.
    // (Negative numbers are produced by the parser via unary minus,
    // so the tokenizer never consumes a leading `-`.)
    if (isDigit(ch) || (ch === "." && i + 1 < src.length && isDigit(src[i + 1]))) {
      const numStart = i;
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === ".") {
        i++;
        while (i < src.length && isDigit(src[i])) i++;
      }
      if (i < src.length && (src[i] === "e" || src[i] === "E")) {
        i++;
        if (i < src.length && (src[i] === "+" || src[i] === "-")) i++;
        const expDigitsStart = i;
        while (i < src.length && isDigit(src[i])) i++;
        if (i === expDigitsStart) {
          tokens.push({
            type: "ERROR",
            text: src.slice(numStart, i),
            start: baseOffset + numStart,
            end: baseOffset + i,
          });
          return tokens;
        }
      }
      const text = src.slice(numStart, i);
      tokens.push({
        type: "NUMBER",
        text,
        value: parseFloat(text),
        start: baseOffset + numStart,
        end: baseOffset + i,
      });
      continue;
    }
    // Cell reference (with optional `$` qualifiers) or identifier /
    // function name / boolean literal. We greedily scan
    // `[$A-Za-z][A-Za-z0-9_.]*` and then disambiguate.
    if (ch === "$" || isLetter(ch) || ch === "_") {
      const idStart = i;
      while (
        i < src.length &&
        (isLetter(src[i]) ||
          isDigit(src[i]) ||
          src[i] === "$" ||
          src[i] === "_" ||
          src[i] === ".")
      ) {
        i++;
      }
      const raw = src.slice(idStart, i);
      const upper = raw.toUpperCase();
      // Cell reference detection — `\$?[A-Z]+\$?\d+`. We additionally
      // check the next non-whitespace character for `!` so that a
      // cell-ref-shaped identifier followed by the sheet separator
      // (e.g. `Sheet1!A1`, where `Sheet1` happens to match
      // `[A-Z]+\d+`) is emitted as IDENTIFIER and routed through
      // the sheet-qualified-reference parse path. Without this
      // look-ahead, `Sheet1` would tokenize as a CELL_REF and the
      // parser would see a stray `!` it can't attach to anything.
      const cellMatch = /^(\$?)([A-Z]+)(\$?)(\d+)$/.exec(upper);
      let nextNonWs = i;
      while (
        nextNonWs < src.length &&
        (src[nextNonWs] === " " || src[nextNonWs] === "\t")
      ) {
        nextNonWs++;
      }
      const followedByBang = nextNonWs < src.length && src[nextNonWs] === "!";
      if (cellMatch && !followedByBang) {
        const absoluteCol = cellMatch[1] === "$";
        const colLetters = cellMatch[2];
        const absoluteRow = cellMatch[3] === "$";
        const rowDigits = cellMatch[4];
        const col = columnLettersToIndex(colLetters);
        const row = parseInt(rowDigits, 10) - 1;
        if (row < 0) {
          tokens.push({
            type: "ERROR",
            text: raw,
            start: baseOffset + idStart,
            end: baseOffset + i,
          });
          return tokens;
        }
        tokens.push({
          type: "CELL_REF",
          text: raw,
          cellRef: { absoluteCol, col, absoluteRow, row },
          start: baseOffset + idStart,
          end: baseOffset + i,
        });
        continue;
      }
      // Boolean literal
      if (upper === "TRUE" || upper === "FALSE") {
        tokens.push({
          type: "BOOLEAN",
          text: raw,
          value: upper === "TRUE",
          start: baseOffset + idStart,
          end: baseOffset + i,
        });
        continue;
      }
      // Function name = identifier immediately followed by `(`.
      // We allow whitespace between the name and `(` (Excel
      // tolerates this).
      let j = i;
      while (j < src.length && (src[j] === " " || src[j] === "\t")) j++;
      if (j < src.length && src[j] === "(") {
        tokens.push({
          type: "FUNCTION_NAME",
          text: raw,
          value: upper,
          start: baseOffset + idStart,
          end: baseOffset + i,
        });
        continue;
      }
      tokens.push({
        type: "IDENTIFIER",
        text: raw,
        value: upper,
        start: baseOffset + idStart,
        end: baseOffset + i,
      });
      continue;
    }
    // Punctuation
    if (ch === "(") {
      tokens.push({ type: "LPAREN", text: "(", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "RPAREN", text: ")", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "COMMA", text: ",", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: "COLON", text: ":", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    if (ch === "%") {
      tokens.push({ type: "PERCENT", text: "%", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    // Multi-character operators
    if (ch === "<") {
      if (src[i + 1] === "=") {
        tokens.push({ type: "OPERATOR", text: "<=", start: absStart, end: absStart + 2 });
        i += 2;
        continue;
      }
      if (src[i + 1] === ">") {
        tokens.push({ type: "OPERATOR", text: "<>", start: absStart, end: absStart + 2 });
        i += 2;
        continue;
      }
      tokens.push({ type: "OPERATOR", text: "<", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    if (ch === ">") {
      if (src[i + 1] === "=") {
        tokens.push({ type: "OPERATOR", text: ">=", start: absStart, end: absStart + 2 });
        i += 2;
        continue;
      }
      tokens.push({ type: "OPERATOR", text: ">", start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    if (
      ch === "+" ||
      ch === "-" ||
      ch === "*" ||
      ch === "/" ||
      ch === "^" ||
      ch === "&" ||
      ch === "="
    ) {
      tokens.push({ type: "OPERATOR", text: ch, start: absStart, end: absStart + 1 });
      i++;
      continue;
    }
    // Anything else is a hard error.
    tokens.push({
      type: "ERROR",
      text: ch,
      start: absStart,
      end: absStart + 1,
    });
    return tokens;
  }
  tokens.push({ type: "EOF", text: "", start: baseOffset + i, end: baseOffset + i });
  return tokens;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

/**
 * Convert an A1-style column letter sequence (`A`, `Z`, `AA`,
 * `AZ`, `XFD`, …) to a zero-based column index. Caller has
 * validated that the input matches `/^[A-Z]+$/`.
 *
 * Exported so the parser can re-use this when a `FUNCTION_NAME`
 * disambiguation later needs the column index without re-tokenizing.
 */
export function columnLettersToIndex(letters: string): number {
  let n = 0;
  for (let k = 0; k < letters.length; k++) {
    n = n * 26 + (letters.charCodeAt(k) - 64);
  }
  return n - 1;
}
