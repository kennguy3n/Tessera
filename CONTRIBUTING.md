# Contributing to Tessera

Thank you for your interest in contributing to Tessera! This guide covers everything you need to set up a development environment, build the project, run tests, and submit changes.

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| **Rust** | 1.75+ (stable) | Core engine, N-API bridge |
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

### Lint and format checks

```bash
# Rust
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings

# TypeScript
npm run lint
npm run type-check
```

---

## Code style

### Rust

- **Formatter:** `rustfmt` — run `cargo fmt --all` before committing.
- **Linter:** `clippy` with `-D warnings` — all warnings are errors in CI.
- **Edition:** 2021, minimum Rust version 1.75.
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

## License

MIT — see [LICENSE](LICENSE).
