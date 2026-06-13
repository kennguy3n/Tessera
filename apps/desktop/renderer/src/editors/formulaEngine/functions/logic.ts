/**
 * logic functions.
 *
 *   IF(cond, true_value, false_value?)   ternary; only the chosen
 *                                        branch is evaluated (lazy).
 *   AND(a, b, ...)                       short-circuit on first FALSE
 *   OR(a, b, ...)                        short-circuit on first TRUE
 *   NOT(a)
 *   IFERROR(value, fallback)             catches any error code
 *   IFS(cond1, val1, cond2, val2, ...)   first matching condition wins
 *   SWITCH(expr, m1, v1, m2, v2, ..., default?)
 *
 * IFERROR is the ONE function in the engine that catches errors —
 * the rest of the evaluator follows Excel's errors-propagate rule.
 * We implement it by walking the AST manually so we never call
 * `evaluate()` on `args[0]` without a try/catch — that's the only
 * way to suppress a `FormulaError` returned from a sub-tree without
 * losing the error's structure.
 */
import {
  evaluate,
  toBoolean,
  type FunctionImpl,
} from "../evaluator";
import {
  isFormulaError,
  makeError,
  type FormulaError,
  type FormulaValue,
} from "../types";

const IF: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "IF expects 2 or 3 arguments");
  }
  const cond = evaluate(args[0], ctx);
  if (isFormulaError(cond)) return cond;
  const truthy = toBoolean(cond);
  if (isFormulaError(truthy)) return truthy;
  if (truthy) return evaluate(args[1], ctx);
  if (args.length === 3) return evaluate(args[2], ctx);
  return false;
};

const AND: FunctionImpl = (args, ctx) => {
  if (args.length === 0) return makeError("#ERR!", "AND expects at least 1 argument");
  for (const arg of args) {
    const v = evaluate(arg, ctx);
    if (isFormulaError(v)) return v;
    const b = toBoolean(v);
    if (isFormulaError(b)) return b;
    if (!b) return false;
  }
  return true;
};

const OR: FunctionImpl = (args, ctx) => {
  if (args.length === 0) return makeError("#ERR!", "OR expects at least 1 argument");
  for (const arg of args) {
    const v = evaluate(arg, ctx);
    if (isFormulaError(v)) return v;
    const b = toBoolean(v);
    if (isFormulaError(b)) return b;
    if (b) return true;
  }
  return false;
};

const NOT: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "NOT expects 1 argument");
  const v = evaluate(args[0], ctx);
  if (isFormulaError(v)) return v;
  const b = toBoolean(v);
  if (isFormulaError(b)) return b;
  return !b;
};

const IFERROR: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "IFERROR expects 2 arguments");
  let primary: FormulaValue;
  try {
    primary = evaluate(args[0], ctx);
  } catch {
    // Defensive — `evaluate()` returns errors as values, but if a
    // future bug throws, IFERROR still catches it.
    return evaluate(args[1], ctx);
  }
  if (isFormulaError(primary)) {
    return evaluate(args[1], ctx);
  }
  return primary;
};

const IFS: FunctionImpl = (args, ctx) => {
  if (args.length === 0 || args.length % 2 !== 0) {
    return makeError("#ERR!", "IFS expects (cond, value) pairs");
  }
  for (let i = 0; i < args.length; i += 2) {
    const cond = evaluate(args[i], ctx);
    if (isFormulaError(cond)) return cond;
    const b = toBoolean(cond);
    if (isFormulaError(b)) return b;
    if (b) return evaluate(args[i + 1], ctx);
  }
  return makeError("#N/A", "IFS — no condition matched");
};

const SWITCH: FunctionImpl = (args, ctx) => {
  if (args.length < 3) {
    return makeError("#ERR!", "SWITCH expects expr + at least one (match, value) pair");
  }
  const expr = evaluate(args[0], ctx);
  if (isFormulaError(expr)) return expr;
  let i = 1;
  while (i + 1 < args.length) {
    const m = evaluate(args[i], ctx);
    if (isFormulaError(m)) return m;
    if (equals(expr, m)) return evaluate(args[i + 1], ctx);
    i += 2;
  }
  // Trailing single arg = default.
  if (i < args.length) {
    return evaluate(args[i], ctx);
  }
  return makeError("#N/A", "SWITCH — no match and no default");
};

function equals(a: FormulaValue, b: FormulaValue): boolean {
  if (isFormulaError(a) || isFormulaError(b)) return false;
  if (a === null) a = "";
  if (b === null) b = "";
  if (typeof a === typeof b) {
    if (typeof a === "string") return a.toLowerCase() === (b as string).toLowerCase();
    return a === b;
  }
  return false;
}

const TRUE_FN: FunctionImpl = (args) => {
  if (args.length !== 0) return makeError("#ERR!", "TRUE expects 0 arguments");
  return true;
};

const FALSE_FN: FunctionImpl = (args) => {
  if (args.length !== 0) return makeError("#ERR!", "FALSE expects 0 arguments");
  return false;
};

const XOR: FunctionImpl = (args, ctx) => {
  if (args.length === 0) {
    return makeError("#ERR!", "XOR expects at least 1 argument");
  }
  let trues = 0;
  for (const arg of args) {
    const v = evaluate(arg, ctx);
    if (isFormulaError(v)) return v;
    const b = toBoolean(v);
    if (isFormulaError(b)) return b;
    if (b) trues++;
  }
  // XOR is true when an odd number of arguments are true.
  return trues % 2 === 1;
};

const IFNA: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "IFNA expects 2 arguments");
  const primary = evaluate(args[0], ctx);
  if (isFormulaError(primary) && primary.code === "#N/A") {
    return evaluate(args[1], ctx);
  }
  return primary;
};

const NA: FunctionImpl = (args) => {
  if (args.length !== 0) return makeError("#ERR!", "NA expects 0 arguments");
  return makeError("#N/A", "NA()");
};

const N: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "N expects 1 argument");
  const v = evaluate(args[0], ctx);
  if (isFormulaError(v)) return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  // Text and blanks become 0, matching Excel's N().
  return 0;
};

/** Build an IS* predicate that inspects the evaluated argument. */
function isPredicate(
  name: string,
  test: (v: FormulaValue) => boolean,
): FunctionImpl {
  return (args, ctx) => {
    if (args.length !== 1) return makeError("#ERR!", `${name} expects 1 argument`);
    const v = evaluate(args[0], ctx);
    // IS* functions never propagate errors — that's the whole point
    // of ISERROR / ISERR / ISNA. They classify the value instead.
    return test(v);
  };
}

const ISBLANK = isPredicate("ISBLANK", (v) => v === null);
const ISNUMBER = isPredicate("ISNUMBER", (v) => typeof v === "number");
const ISTEXT = isPredicate("ISTEXT", (v) => typeof v === "string");
const ISNONTEXT = isPredicate(
  "ISNONTEXT",
  (v) => typeof v !== "string",
);
const ISLOGICAL = isPredicate("ISLOGICAL", (v) => typeof v === "boolean");
const ISERROR = isPredicate("ISERROR", (v) => isFormulaError(v));
const ISERR = isPredicate(
  "ISERR",
  (v) => isFormulaError(v) && v.code !== "#N/A",
);
const ISNA = isPredicate(
  "ISNA",
  (v) => isFormulaError(v) && v.code === "#N/A",
);

export const LOGIC_FUNCTIONS: Record<string, FunctionImpl> = {
  IF,
  AND,
  OR,
  NOT,
  XOR,
  IFERROR,
  IFNA,
  IFS,
  SWITCH,
  TRUE: TRUE_FN,
  FALSE: FALSE_FN,
  NA,
  N,
  ISBLANK,
  ISNUMBER,
  ISTEXT,
  ISNONTEXT,
  ISLOGICAL,
  ISERROR,
  ISERR,
  ISNA,
};

// Re-exported for callers that need to know which codes IFERROR catches.
export const ERROR_CODES_CAUGHT_BY_IFERROR: ReadonlyArray<FormulaError["code"]> = [
  "#ERR!",
  "#REF!",
  "#NAME?",
  "#VALUE!",
  "#DIV/0!",
  "#NUM!",
  "#N/A",
  "#CIRCULAR!",
];
