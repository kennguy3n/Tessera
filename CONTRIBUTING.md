# Contributing to Tessera

Thank you for your interest in contributing to Tessera! This guide covers everything you need to set up a development environment, build the project, run tests, and submit changes.

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| **Rust** | 1.88+ (stable) | Core engine, N-API bridge |
| **Node.js** | 20+ | Electron shell, React renderer |
| **npm** | 10+ | Package management |
| **C toolchain** | GCC / Clang | Build bundled SQLCipher + OpenSSL |

### Platform-specific setup

**Ubuntu / Debian:**

```bash
sudo apt install build-essential pkg-config libssl-dev
```

**macOS:**

```bash
xcode-select --install
```

**Windows:**

Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload.

### Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable
rustup component add clippy rustfmt
```

### Install Node.js

Use [nvm](https://github.com/nvm-sh/nvm) or download directly from [nodejs.org](https://nodejs.org/).

```bash
node --version   # should be 20+
npm --version    # should be 10+
```

---

## Development environment setup

```bash
# Clone the repository
git clone https://github.com/kennguy3n/Tessera.git
cd Tessera

# Install Node.js dependencies
npm install

# Build the Rust crates (first build is slow — compiles bundled SQLCipher + OpenSSL)
cargo build --all-targets

# Build the N-API native addon
npm run build:native
```

---

## Building

### Full build

```bash
npm run build
```

This runs both the Rust build (via napi-rs) and the Electron + Vite build.

### Rust only

```bash
cargo build --all-targets
```

### Electron + renderer only

```bash
cd apps/desktop
npm run build
```

---

## Running tests

### All tests

```bash
npm test
```

### Rust tests

```bash
cargo test --all
```

### TypeScript / React tests

```bash
npm run test:ui
```

### Phase-tracking smoke suite

The repo includes a cross-language smoke suite that asserts every
feature claimed in `PROGRESS.md` / `PHASES.md` is actually backed by
importable / callable code. CI runs the suite on every PR and the
phase-exit checklist (see [Phase completion checklist](#phase-completion-checklist)
below) requires it to be green before a phase flips to `DONE`:

```bash
npm run test:smoke
```

The suite covers four targets:

- `apps/desktop/renderer/src/__tests__/smoke/phaseVerification.test.ts` — renderer surfaces, editors, settings.
- `crates/tessera_connectors/tests/phase_smoke_connectors.rs` — every connector module compiles and exposes its expected entry points.
- `crates/tessera_export/tests/phase_smoke_export.rs` — every export format module is reachable.
- `crates/tessera_templates/tests/phase_smoke_templates.rs` — every claimed template ships and validates.

### Lint and format checks

```bash
# Rust
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings

# TypeScript
npm run lint
npm run type-check
```

### Regression tests for security-sensitive changes

When you touch a security-sensitive boundary (IPC handler registration,
preload surface, CSP policy, vault crypto, export path resolution, rate
limiter, password vault, scheduler drain, auto-updater channels), you
**must** ship a regression test that fails without your fix and passes
with it. The pattern lives under
`apps/desktop/electron/__tests__/`; examples to mirror:

- `__tests__/sandboxPreloadContract.test.ts` — pins the preload contract so the renderer cannot escape its sandbox.
- `__tests__/windowAllClosedGuard.test.ts` — pins the macOS / non-macOS quit behaviour so a regression cannot leak background processes.
- `__tests__/exportPathSafety.test.ts` — pins the export-path containment allow-list (rejects symlinks and `..` traversal).
- `__tests__/rateLimiter.test.ts` — pins the token-bucket limiter on expensive IPC channels.
- `__tests__/passwordVault.test.ts` — pins PBKDF2 + AES-GCM round-trip semantics for the keyringless-fallback vault.
- `__tests__/extractedItemValidation.test.ts` — pins zod-shape validation and HTML escape of bridge-supplied extracted items.
- `__tests__/externalProviderStream.test.ts` — pins SSE parsing + retry policy of the external LLM provider.

If you cannot reproduce the failure mode with a unit test, surface the
gap in the PR description so the reviewer can decide whether a
higher-level test (smoke / integration) is required before merge.

---

## Code style

### Rust

- **Formatter:** `rustfmt` — run `cargo fmt --all` before committing.
- **Linter:** `clippy` with `-D warnings` — all warnings are errors in CI.
- **Edition:** 2021, minimum Rust version 1.88 (transitive deps require `edition2024` (≥1.85), `icu_collections >=2.2.0` (1.86), and `image`/`time`/`plist`/`napi-build` recent versions (1.88)). Bumps will track upstream MSRV moves; CI pins the floor.
- Follow the formatting rules in `rustfmt.toml` (matches the [knowledge](https://github.com/kennguy3n/knowledge) substrate).

### TypeScript / React

- **Formatter:** Prettier — run `npx prettier --write .` to format.
- **Linter:** ESLint — run `npm run lint` to check.
- **Style:** Functional components, hooks, strict TypeScript (`strict: true`).

### General

- No `TODO` or `FIXME` comments in production code.
- No `any` types in TypeScript.
- No `unsafe` code in Rust (enforced via `#![forbid(unsafe_code)]` where applicable).
- Imports at the top of every file.

---

## PR process

1. **Branch from `main`** — use a descriptive branch name (e.g., `feat/local-folder-indexing`, `fix/search-ranking`).
2. **Keep commits focused** — one logical change per commit.
3. **Write tests** — every new feature or bug fix should include tests.
4. **Pass CI** — all checks must pass before merge:
   - `cargo fmt --check`
   - `cargo clippy` (warnings as errors)
   - `cargo test --all`
   - `npm run lint`
   - `npm run type-check`
   - `npm test`
5. **Write a clear PR description** — explain what changed, why, and how to test it.

### Commit message conventions

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): short description

feat(sources): add file watcher for local folders
fix(search): correct FTS5 ranking for multi-word queries
docs(readme): update build instructions
test(citations): add integration tests for citation tracking
chore(ci): add macOS runner to CI matrix
```

**Types:** `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `style`.

---

## Issue reporting

### Bug reports

Open a [GitHub issue](https://github.com/kennguy3n/Tessera/issues) with:

- **Description:** What happened vs. what you expected.
- **Steps to reproduce:** Minimal steps to trigger the bug.
- **Environment:** OS, Rust version, Node.js version.
- **Logs / screenshots:** Relevant error output or screenshots.

### Feature requests

Open an issue with the `enhancement` label:

- **Use case:** What problem does this solve?
- **Proposed solution:** How should it work?
- **Alternatives considered:** What other approaches did you consider?

---

## Project structure

```
tessera/
├── apps/desktop/
│   ├── electron/          # Electron main process
│   └── renderer/          # React / TypeScript UI
├── crates/                # Rust workspace
│   ├── tessera_core/      # Core types, config, errors
│   ├── tessera_bridge/    # N-API bindings for Electron
│   ├── tessera_sources/   # Source management, indexing, search
│   ├── tessera_templates/ # Template parsing and validation
│   ├── tessera_artifacts/ # Artifact CRUD and storage
│   ├── tessera_citations/ # Citation tracking and provenance
│   ├── tessera_export/    # Export engine (MD, HTML, CSV)
│   └── tessera_audit/     # Audit trail logging
├── templates/             # YAML artifact templates
├── schemas/               # JSON schemas
└── docs/                  # Additional documentation
```

---

## Phase completion checklist

Tessera ships in phases, tracked in [`PROGRESS.md`](PROGRESS.md) and
specified in [`PHASES.md`](PHASES.md). Before a phase is marked `DONE`
in `PROGRESS.md`, the maintainer closing the phase must verify each of
the following — every item is a guard against the Phase 7/8 tracking
gap, where features were marked DONE in the planning docs before the
underlying code had landed in the workspace.

1. **All Build items are `DONE` in `PROGRESS.md`.**
   Every line in the phase's Build table is marked `DONE` and the
   commit / PR that delivered it is linkable. No `IN PROGRESS` or
   `NOT STARTED` entries remain.

2. **All Exit Criteria checkboxes are checked.**
   Every bullet under the phase's "Exit criteria" section in
   `PROGRESS.md` is `[x]`. Exit criteria describe observable outcomes
   ("the renderer launches", "the user can export PDF"), not source
   files — checking these forces the closer to actually exercise the
   feature, not just inspect the diff.

3. **Smoke tests pass (`npm run test:smoke`).**
   The smoke suite is the structural floor: it asserts every claimed
   feature is backed by importable, callable code (not just docs or a
   TODO). It covers
   - the desktop renderer
     (`apps/desktop/renderer/src/__tests__/smoke/phaseVerification.test.ts`),
   - the connectors crate
     (`crates/tessera_connectors/tests/phase_smoke_connectors.rs`),
   - the export crate
     (`crates/tessera_export/tests/phase_smoke_export.rs`),
   - the templates crate
     (`crates/tessera_templates/tests/phase_smoke_templates.rs`).

   If a smoke test starts failing because a feature in scope for an
   already-closed phase regressed, the regression must be fixed before
   the *next* phase can close — the suite is the historical
   reality-check for every prior phase, not just the current one.

4. **Every feature claimed in the phase has at least one test that
   exercises real code (not just type stubs).**
   For each Build item in the phase, locate the test(s) that cover it.
   A unit test that only constructs a struct or imports a module is
   not sufficient; the test must call into the production code path
   the feature describes. If a feature genuinely cannot be tested
   automatically (e.g. an OAuth interactive flow), document the manual
   verification step in the PR description.

5. **`README.md`, `ARCHITECTURE.md`, `PHASES.md`, and `PROGRESS.md`
   are updated consistently.**
   Cross-document drift is the original sin behind the Phase 7/8 gap.
   Before flipping the phase to `DONE`, grep for the phase name across
   the four docs and reconcile every reference. New features mentioned
   in `README.md` or `ARCHITECTURE.md` must have a matching Build line
   in `PROGRESS.md`; conversely, Build lines that did not ship must be
   removed from the phase (not silently left as DONE).

If any item above fails, the phase stays `IN PROGRESS`. The
[tracking-integrity callout](PROGRESS.md#tracking-integrity-note) at
the top of `PROGRESS.md` documents why this checklist exists.

---

## License

MIT — see [LICENSE](LICENSE).
