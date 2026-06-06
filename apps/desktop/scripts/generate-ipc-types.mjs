// @ts-check
/**
 * Generate renderer-side TypeScript types from the zod IPC schemas.
 *
 * Source of truth: `apps/desktop/electron/ipc/schemas.ts`. Every
 * `export type XInput = z.infer<typeof XSchema>` declared there is
 * resolved to its fully-expanded structural type via the TypeScript
 * type checker and re-emitted as a standalone type alias into
 * `apps/desktop/renderer/src/generated/ipcTypes.ts`.
 *
 * Why generate instead of importing: the renderer must not import from
 * `electron/` (different tsconfig project, and the renderer is the
 * untrusted web context). Re-emitting the inferred types gives the
 * renderer a dependency-free, zod-free view of the exact payload shapes
 * the IPC layer validates, so the two cannot silently drift.
 *
 * Usage:
 *   node scripts/generate-ipc-types.mjs          # write the file
 *   node scripts/generate-ipc-types.mjs --check  # fail if out of date
 *
 * The `--check` mode is what CI runs: it regenerates in-memory and
 * diffs against the committed file, exiting non-zero (and printing the
 * diff) when they disagree.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const prettier = require("prettier");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopDir, "..", "..");
const schemasPath = path.join(desktopDir, "electron", "ipc", "schemas.ts");
const outPath = path.join(
  desktopDir,
  "renderer",
  "src",
  "generated",
  "ipcTypes.ts",
);

/** Build a TS Program from the electron tsconfig so imports resolve. */
function createProgram() {
  const tsconfigPath = path.join(desktopDir, "tsconfig.electron.json");
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(
      ts.formatDiagnostic(configFile.error, formatHost),
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    desktopDir,
  );
  return ts.createProgram({
    rootNames: [schemasPath],
    options: { ...parsed.options, noEmit: true },
  });
}

const formatHost = {
  getCanonicalFileName: (/** @type {string} */ f) => f,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};

/**
 * Return the exported `type X = z.infer<typeof ...>` alias names in the
 * order they appear in schemas.ts.
 * @param {import("typescript").SourceFile} source
 */
function collectInferAliasNames(source) {
  /** @type {string[]} */
  const names = [];
  for (const stmt of source.statements) {
    if (!ts.isTypeAliasDeclaration(stmt)) continue;
    const isExported = (stmt.modifiers ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;
    if (!ts.isTypeReferenceNode(stmt.type)) continue;
    const typeName = stmt.type.typeName;
    // Match `z.infer<...>`.
    if (
      ts.isQualifiedName(typeName) &&
      ts.isIdentifier(typeName.left) &&
      typeName.left.text === "z" &&
      typeName.right.text === "infer"
    ) {
      names.push(stmt.name.text);
    }
  }
  return names;
}

// TS utility/built-in type names that are always in scope and must
// never be treated as a project type needing a standalone emit.
const BUILTIN_TYPE_NAMES = new Set([
  "Array",
  "ReadonlyArray",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Exclude",
  "Extract",
  "NonNullable",
  "ReturnType",
  "Parameters",
  "Map",
  "ReadonlyMap",
  "Set",
  "ReadonlySet",
  "Date",
  "Promise",
  "RegExp",
  "Uint8Array",
  "Buffer",
]);

/**
 * Extract candidate PascalCase type identifiers referenced in a printed
 * type string.
 * @param {string} text
 * @returns {Set<string>}
 */
function referencedTypeNames(text) {
  /** @type {Set<string>} */
  const refs = new Set();
  const matches = text.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  for (const m of matches) {
    if (!BUILTIN_TYPE_NAMES.has(m)) refs.add(m);
  }
  return refs;
}

/**
 * Map every exported `type`/`interface` declared in project (non-
 * `node_modules`, non-`.d.ts`) source files to its symbol, so referenced
 * domain types can be resolved and re-emitted.
 * @param {import("typescript").Program} program
 * @param {import("typescript").TypeChecker} checker
 * @returns {Map<string, import("typescript").Symbol>}
 */
function collectProjectTypeDecls(program, checker) {
  /** @type {Map<string, import("typescript").Symbol>} */
  const map = new Map();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (sf.fileName.includes("node_modules")) continue;
    for (const stmt of sf.statements) {
      if (
        !ts.isTypeAliasDeclaration(stmt) &&
        !ts.isInterfaceDeclaration(stmt)
      ) {
        continue;
      }
      const isExported = (stmt.modifiers ?? []).some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) continue;
      const name = stmt.name.text;
      if (map.has(name)) continue;
      const sym = checker.getSymbolAtLocation(stmt.name);
      if (sym) map.set(name, sym);
    }
  }
  return map;
}

function generate() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(schemasPath);
  if (!source) {
    throw new Error(`Could not load source file: ${schemasPath}`);
  }

  const names = collectInferAliasNames(source);
  if (names.length === 0) {
    throw new Error("No `z.infer` type aliases found in schemas.ts");
  }

  const flags =
    ts.TypeFormatFlags.NoTruncation |
    ts.TypeFormatFlags.InTypeAlias |
    ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType;

  /** @type {Map<string, import("typescript").Symbol>} */
  const exportsByName = new Map();
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol) {
    for (const sym of checker.getExportsOfModule(moduleSymbol)) {
      exportsByName.set(sym.getName(), sym);
    }
  }

  const blocks = [];
  for (const name of names) {
    const sym = exportsByName.get(name);
    if (!sym) throw new Error(`Export not found for type ${name}`);
    const decl = sym.declarations?.[0];
    if (!decl) throw new Error(`No declaration for type ${name}`);
    const type = checker.getDeclaredTypeOfSymbol(sym);
    const printed = checker.typeToString(type, decl, flags);
    blocks.push(`export type ${name} = ${printed};`);
  }

  // Some schemas are annotated with a nominal domain type (e.g.
  // `z.ZodType<AutomationAction>` for the recursive `sequence` action),
  // so `z.infer` resolves to that type *name* rather than an inlined
  // structure. The renderer must not import from electron/shared, so we
  // re-emit every such referenced project type as a standalone alias,
  // following references transitively until the output is self-contained.
  const projectTypes = collectProjectTypeDecls(program, checker);
  const emitted = new Set(names);
  const queue = [];
  for (const block of blocks) {
    for (const ref of referencedTypeNames(block)) {
      if (!emitted.has(ref) && projectTypes.has(ref)) queue.push(ref);
    }
  }
  while (queue.length > 0) {
    const refName = queue.shift();
    if (emitted.has(refName)) continue;
    emitted.add(refName);
    const sym = projectTypes.get(refName);
    const decl = sym.declarations?.[0];
    const type = checker.getDeclaredTypeOfSymbol(sym);
    const printed = checker.typeToString(type, decl, flags);
    blocks.push(`export type ${refName} = ${printed};`);
    for (const ref of referencedTypeNames(printed)) {
      if (!emitted.has(ref) && projectTypes.has(ref)) queue.push(ref);
    }
  }

  const header = `/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Generated from \`apps/desktop/electron/ipc/schemas.ts\` by
 * \`apps/desktop/scripts/generate-ipc-types.mjs\`.
 *
 * Regenerate with:  npm run generate:ipc-types --workspace=apps/desktop
 * CI fails (see the "Check generated IPC types" step) if this file is
 * out of date relative to the zod schemas.
 */
`;

  return header + "\n" + blocks.join("\n\n") + "\n";
}

async function main() {
  const raw = generate();
  const prettierConfig = await prettier.resolveConfig(outPath);
  const formatted = await prettier.format(raw, {
    ...prettierConfig,
    parser: "typescript",
    filepath: outPath,
  });

  const check = process.argv.includes("--check");
  const existing = fs.existsSync(outPath)
    ? fs.readFileSync(outPath, "utf8")
    : null;

  if (check) {
    if (existing !== formatted) {
      console.error(
        "\n[generate-ipc-types] Generated IPC types are OUT OF DATE.\n" +
          "Run `npm run generate:ipc-types --workspace=apps/desktop` and commit\n" +
          `the result (${path.relative(repoRoot, outPath)}).\n`,
      );
      if (existing == null) {
        console.error("(committed file is missing)");
      }
      process.exit(1);
    }
    console.log("[generate-ipc-types] Generated IPC types are up to date.");
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, formatted);
  console.log(
    `[generate-ipc-types] Wrote ${path.relative(repoRoot, outPath)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
