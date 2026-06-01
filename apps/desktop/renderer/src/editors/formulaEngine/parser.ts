/**
 * recursive-descent parser.
 *
 * Consumes the token stream from `tokenize()` and produces a typed AST.
 * The grammar matches the precedence/associativity ladder Excel and
 * Google Sheets follow:
 *
 *   Expression       → Comparison
 *   Comparison       → Concatenation (('=' | '<>' | '<' | '>' | '<=' | '>=') Concatenation)*
 *   Concatenation    → Addition ('&' Addition)*
 *   Addition         → Multiplication (('+' | '-') Multiplication)*
 *   Multiplication   → Power (('*' | '/') Power)*
 *   Power            → Unary ('^' Unary)*           (right-associative)
 *   Unary            → ('-' | '+') Unary | Postfix
 *   Postfix          → Primary ('%')?
 *   Primary          → NUMBER | STRING | BOOLEAN
 *                    | CellOrRange
 *                    | FUNCTION_NAME '(' ArgList? ')'
 *                    | IDENTIFIER
 *                    | '(' Expression ')'
 *   CellOrRange      → CELL_REF (':' CELL_REF)?
 *   ArgList          → Expression (',' Expression)*
 *
 * Comparison is intentionally non-associative in Excel (`A1=B1=C1`
 * is an error), but a left-associative parse — the same as Google
 * Sheets — is far more useful in practice and matches what users
 * type. The evaluator coerces the LHS of the second comparison from
 * `boolean` -> `0|1` for arithmetic compatibility, so the behaviour
 * is well-defined and tested in `parser.test.ts`.
 *
 * The parser returns `{ ast }` on success or `{ error: <message> }`
 * on a syntactic error. We never throw — the evaluator surfaces the
 * error as `#ERR!` in the cell.
 */
import type { Token } from "./tokenizer";
import { tokenize } from "./tokenizer";

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "&"
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">=";

export type UnaryOp = "+" | "-" | "%";

/**
 * AST node shape. `cell` and `range` carry an optional `sheet`
 * naming a sibling worksheet . When
 * absent, the reference targets the active sheet — backward
 * compatible with all pre-multi-sheet formulas.
 */
export type AstNode =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | {
      type: "cell";
      row: number;
      col: number;
      absoluteRow: boolean;
      absoluteCol: boolean;
      sheet?: string;
    }
  | {
      type: "range";
      start: {
        row: number;
        col: number;
        absoluteRow: boolean;
        absoluteCol: boolean;
      };
      end: {
        row: number;
        col: number;
        absoluteRow: boolean;
        absoluteCol: boolean;
      };
      sheet?: string;
    }
  | { type: "identifier"; name: string }
  | { type: "function"; name: string; args: AstNode[] }
  | { type: "unary"; op: UnaryOp; operand: AstNode }
  | { type: "binary"; op: BinaryOp; left: AstNode; right: AstNode };

export interface ParseSuccess {
  readonly ok: true;
  readonly ast: AstNode;
}

export interface ParseFailure {
  readonly ok: false;
  /** Excel-style sentinel (`#ERR!` or `#REF!`). */
  readonly code: "#ERR!" | "#REF!";
  /** Human-readable diagnostic, for debugging / tooltips. */
  readonly message: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

/** Convenience: tokenize + parse in a single call. */
export function parseFormula(input: string): ParseResult {
  return new Parser(tokenize(input)).parse();
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ParseResult {
    // A leading scanner error means the formula didn't tokenize
    // cleanly — surface as `#ERR!` straight away.
    const firstError = this.tokens.find((t) => t.type === "ERROR");
    if (firstError) {
      return {
        ok: false,
        code: "#ERR!",
        message: `scanner error near "${firstError.text}"`,
      };
    }
    if (this.tokens.length === 1 && this.tokens[0].type === "EOF") {
      // Empty formula: parse as `0` so an empty `=` cell doesn't
      // explode the renderer. (Excel treats `=` alone as `#NAME?`,
      // but Tessera artifacts are user-authored and an empty
      // formula is most commonly the user pressing Enter mid-edit.)
      return { ok: true, ast: { type: "number", value: 0 } };
    }
    let ast: AstNode;
    try {
      ast = this.parseExpression();
    } catch (err) {
      const message = err instanceof ParseError ? err.message : String(err);
      const code: "#ERR!" | "#REF!" =
        err instanceof ParseError ? err.code : "#ERR!";
      return { ok: false, code, message };
    }
    if (this.peek().type !== "EOF") {
      return {
        ok: false,
        code: "#ERR!",
        message: `unexpected token "${this.peek().text}"`,
      };
    }
    return { ok: true, ast };
  }

  // ----- precedence ladder ------------------------------------------------

  private parseExpression(): AstNode {
    return this.parseComparison();
  }

  private parseComparison(): AstNode {
    let left = this.parseConcatenation();
    while (this.isComparisonOp(this.peek())) {
      const opTok = this.advance();
      const right = this.parseConcatenation();
      left = { type: "binary", op: opTok.text as BinaryOp, left, right };
    }
    return left;
  }

  private parseConcatenation(): AstNode {
    let left = this.parseAddition();
    while (this.peek().type === "OPERATOR" && this.peek().text === "&") {
      this.advance();
      const right = this.parseAddition();
      left = { type: "binary", op: "&", left, right };
    }
    return left;
  }

  private parseAddition(): AstNode {
    let left = this.parseMultiplication();
    while (
      this.peek().type === "OPERATOR" &&
      (this.peek().text === "+" || this.peek().text === "-")
    ) {
      const op = this.advance().text as "+" | "-";
      const right = this.parseMultiplication();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseMultiplication(): AstNode {
    let left = this.parsePower();
    while (
      this.peek().type === "OPERATOR" &&
      (this.peek().text === "*" || this.peek().text === "/")
    ) {
      const op = this.advance().text as "*" | "/";
      const right = this.parsePower();
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parsePower(): AstNode {
    const left = this.parseUnary();
    if (this.peek().type === "OPERATOR" && this.peek().text === "^") {
      this.advance();
      // Right-associative.
      const right = this.parsePower();
      return { type: "binary", op: "^", left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (
      this.peek().type === "OPERATOR" &&
      (this.peek().text === "-" || this.peek().text === "+")
    ) {
      const op = this.advance().text as "+" | "-";
      const operand = this.parseUnary();
      return { type: "unary", op, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): AstNode {
    let node = this.parsePrimary();
    while (this.peek().type === "PERCENT") {
      this.advance();
      node = { type: "unary", op: "%", operand: node };
    }
    return node;
  }

  private parsePrimary(): AstNode {
    const tok = this.peek();
    switch (tok.type) {
      case "NUMBER":
        this.advance();
        return { type: "number", value: tok.value as number };
      case "STRING":
        this.advance();
        return { type: "string", value: tok.value as string };
      case "BOOLEAN":
        this.advance();
        return { type: "boolean", value: tok.value as boolean };
      case "CELL_REF":
        return this.parseCellOrRange();
      case "FUNCTION_NAME":
        return this.parseFunctionCall();
      case "IDENTIFIER": {
        this.advance();
        // Sheet-qualified reference: `IDENTIFIER ! CELL_REF[:CELL_REF]`.
        // Otherwise the identifier is a (possibly future) named-range
        // reference handed back to the evaluator.
        if (this.peek().type === "BANG") {
          this.advance();
          if (this.peek().type !== "CELL_REF") {
            throw new ParseError(
              "#ERR!",
              `expected cell reference after "${tok.text}!"`,
            );
          }
          return this.parseCellOrRange(tok.value as string);
        }
        return { type: "identifier", name: tok.value as string };
      }
      case "SHEET_QUOTED": {
        this.advance();
        if (this.peek().type !== "BANG") {
          throw new ParseError(
            "#ERR!",
            `quoted sheet name "${tok.value as string}" must be followed by "!"`,
          );
        }
        this.advance();
        if (this.peek().type !== "CELL_REF") {
          throw new ParseError(
            "#ERR!",
            `expected cell reference after "'${tok.value as string}'!"`,
          );
        }
        return this.parseCellOrRange(tok.value as string);
      }
      case "LPAREN": {
        this.advance();
        const inner = this.parseExpression();
        this.expect("RPAREN", ")");
        return inner;
      }
      case "OPERATOR":
        throw new ParseError(
          "#ERR!",
          `unexpected operator "${tok.text}" — expected a value`,
        );
      case "RPAREN":
      case "COMMA":
      case "COLON":
      case "BANG":
      case "EOF":
        throw new ParseError(
          "#ERR!",
          `unexpected token "${tok.text || "<eof>"}"`,
        );
      case "ERROR":
        throw new ParseError("#ERR!", `scanner error near "${tok.text}"`);
      case "PERCENT":
        // Postfix `%` can only appear after a primary — at the start
        // of one it is a syntax error.
        throw new ParseError(
          "#ERR!",
          `unexpected "%" — expected a value first`,
        );
      default: {
        const _exhaust: never = tok.type;
        throw new ParseError("#ERR!", `unrecognised token ${String(_exhaust)}`);
      }
    }
  }

  /**
   * Parse a `CELL_REF` or `CELL_REF ':' CELL_REF` range. When called
   * from a sheet-qualified context (`Sheet2!A1`), `sheet` carries
   * the sheet name and is attached to the produced AST node. Both
   * endpoints of a range share the same sheet — Excel and Google
   * Sheets disallow mixing sheets within a single `A1:B5` literal,
   * and our tokenizer never emits a CELL_REF with its own sheet
   * prefix anyway.
   */
  private parseCellOrRange(sheet?: string): AstNode {
    const first = this.advance();
    if (!first.cellRef) {
      throw new ParseError("#REF!", `bad cell reference "${first.text}"`);
    }
    const startCol = first.cellRef.col;
    const startRow = first.cellRef.row;
    const startAbsCol = first.cellRef.absoluteCol;
    const startAbsRow = first.cellRef.absoluteRow;
    if (this.peek().type === "COLON") {
      this.advance();
      if (this.peek().type !== "CELL_REF") {
        throw new ParseError(
          "#ERR!",
          "':' must be followed by a second cell reference",
        );
      }
      const second = this.advance();
      if (!second.cellRef) {
        throw new ParseError("#REF!", `bad cell reference "${second.text}"`);
      }
      // Normalise endpoints so start <= end on both axes.
      const minRow = Math.min(startRow, second.cellRef.row);
      const maxRow = Math.max(startRow, second.cellRef.row);
      const minCol = Math.min(startCol, second.cellRef.col);
      const maxCol = Math.max(startCol, second.cellRef.col);
      const range: AstNode = {
        type: "range",
        start: {
          row: minRow,
          col: minCol,
          absoluteRow:
            startRow <= second.cellRef.row
              ? startAbsRow
              : second.cellRef.absoluteRow,
          absoluteCol:
            startCol <= second.cellRef.col
              ? startAbsCol
              : second.cellRef.absoluteCol,
        },
        end: {
          row: maxRow,
          col: maxCol,
          absoluteRow:
            startRow >= second.cellRef.row
              ? startAbsRow
              : second.cellRef.absoluteRow,
          absoluteCol:
            startCol >= second.cellRef.col
              ? startAbsCol
              : second.cellRef.absoluteCol,
        },
      };
      if (sheet) range.sheet = sheet;
      return range;
    }
    const cell: AstNode = {
      type: "cell",
      row: startRow,
      col: startCol,
      absoluteRow: startAbsRow,
      absoluteCol: startAbsCol,
    };
    if (sheet) cell.sheet = sheet;
    return cell;
  }

  private parseFunctionCall(): AstNode {
    const nameTok = this.advance();
    this.expect("LPAREN", "(");
    const args: AstNode[] = [];
    if (this.peek().type !== "RPAREN") {
      args.push(this.parseExpression());
      while (this.peek().type === "COMMA") {
        this.advance();
        args.push(this.parseExpression());
      }
    }
    this.expect("RPAREN", ")");
    return { type: "function", name: nameTok.value as string, args };
  }

  // ----- helpers ----------------------------------------------------------

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: Token["type"], lex: string): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new ParseError(
        "#ERR!",
        `expected "${lex}" but found "${tok.text || "<eof>"}"`,
      );
    }
    return this.advance();
  }

  private isComparisonOp(tok: Token): boolean {
    if (tok.type !== "OPERATOR") return false;
    return (
      tok.text === "=" ||
      tok.text === "<>" ||
      tok.text === "<" ||
      tok.text === ">" ||
      tok.text === "<=" ||
      tok.text === ">="
    );
  }
}

class ParseError extends Error {
  constructor(
    readonly code: "#ERR!" | "#REF!",
    message: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}
