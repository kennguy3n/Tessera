// @ts-check
/**
 * Generate `docs/DEPENDENCIES.md` — a license inventory of every
 * third-party dependency Tessera ships or builds against.
 *
 * Two sources, each using the toolchain's own native metadata so the
 * script needs no extra dependencies:
 *
 *   - Rust:  `cargo metadata --format-version 1 --all-features`. Every
 *            package in the resolved dependency graph except the
 *            first-party workspace crates is listed with its version,
 *            SPDX license expression, and repository.
 *   - npm:   a recursive scan of `node_modules` (the full installed
 *            tree, including transitive and dev dependencies), reading
 *            each package's own `package.json` `license` field.
 *
 * Reproduce with:
 *
 *     node scripts/generate-dependencies.mjs
 *
 * Run `npm ci` and have a Rust toolchain on PATH first so both trees
 * are fully resolved. The output is deterministic (every table is
 * sorted) so re-running on an unchanged tree is a no-op diff.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outPath = path.join(repoRoot, "docs", "DEPENDENCIES.md");

/** Escape a value for inclusion in a Markdown table cell. */
function md(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

/** Normalise an npm `license` / `licenses` field to a string. */
function normalizeNpmLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) {
    return String(pkg.license.type);
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l) => (typeof l === "string" ? l : l?.type))
      .filter(Boolean);
    if (types.length > 0) return types.join(" OR ");
  }
  return "UNKNOWN";
}

function npmRepository(pkg) {
  const r = pkg.repository;
  if (!r) return "";
  if (typeof r === "string") return r;
  if (typeof r === "object" && typeof r.url === "string") {
    return r.url.replace(/^git\+/, "").replace(/\.git$/, "");
  }
  return "";
}

/**
 * Recursively collect every installed npm package under a node_modules
 * directory into `out` (keyed by `name@version`).
 */
function scanNodeModules(nodeModulesDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === ".bin" || entry.name === ".cache") continue;
    const full = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      // Scope directory: recurse one level to the actual packages.
      scanScope(full, out);
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    recordPackage(full, out);
  }
}

function scanScope(scopeDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    recordPackage(path.join(scopeDir, entry.name), out);
  }
}

function recordPackage(pkgDir, out) {
  const manifestPath = path.join(pkgDir, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return;
  }
  if (pkg && typeof pkg.name === "string" && typeof pkg.version === "string") {
    const key = `${pkg.name}@${pkg.version}`;
    if (!out.has(key)) {
      out.set(key, {
        name: pkg.name,
        version: pkg.version,
        license: normalizeNpmLicense(pkg),
        repository: npmRepository(pkg),
      });
    }
  }
  // Nested deps (npm's deduped tree still nests version conflicts).
  scanNodeModules(path.join(pkgDir, "node_modules"), out);
}

function collectNpm() {
  const out = new Map();
  scanNodeModules(path.join(repoRoot, "node_modules"), out);
  return [...out.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
}

function collectRust() {
  const raw = execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--all-features"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const meta = JSON.parse(raw);
  const workspaceIds = new Set(meta.workspace_members ?? []);
  return (meta.packages ?? [])
    .filter((p) => !workspaceIds.has(p.id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? (p.license_file ? "see license file" : "UNKNOWN"),
      repository: p.repository ?? "",
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
    );
}

function licenseSummary(rows) {
  const counts = new Map();
  for (const r of rows) {
    counts.set(r.license, (counts.get(r.license) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}

function table(rows) {
  const lines = [
    "| Package | Version | License | Repository |",
    "| --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${md(r.name)} | ${md(r.version)} | ${md(r.license)} | ${md(
        r.repository,
      )} |`,
    );
  }
  return lines.join("\n");
}

function summaryTable(rows) {
  const lines = ["| License | Count |", "| --- | --- |"];
  for (const [license, count] of licenseSummary(rows)) {
    lines.push(`| ${md(license)} | ${count} |`);
  }
  return lines.join("\n");
}

function main() {
  const rust = collectRust();
  const npm = collectNpm();

  const content = `<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Regenerate with:  node scripts/generate-dependencies.mjs
  (run \`npm ci\` and have a Rust toolchain on PATH first).
-->

# Dependencies

License inventory of every third-party dependency Tessera builds
against or ships, generated from the toolchains' own metadata. See the
header comment of [\`scripts/generate-dependencies.mjs\`](../scripts/generate-dependencies.mjs)
for the exact data sources.

Reproduce:

\`\`\`sh
node scripts/generate-dependencies.mjs
\`\`\`

- **Rust crates:** ${rust.length} (from \`cargo metadata --format-version 1 --all-features\`, excluding the first-party workspace crates)
- **npm packages:** ${npm.length} (full installed \`node_modules\` tree, incl. transitive + dev)

## Rust — license summary

${summaryTable(rust)}

## npm — license summary

${summaryTable(npm)}

## Rust crates

${table(rust)}

## npm packages

${table(npm)}
`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, content);
  console.log(
    `[generate-dependencies] Wrote ${path.relative(repoRoot, outPath)} ` +
      `(${rust.length} Rust crates, ${npm.length} npm packages)`,
  );
}

main();
