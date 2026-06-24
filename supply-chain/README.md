# Supply-chain audit (`cargo vet`)

This directory is the [`cargo vet`](https://mozilla.github.io/cargo-vet/)
store. It is enforced in CI by the **Supply-chain audit** job in
`.github/workflows/ci.yml` (`cargo vet --locked`).

> **Note:** `config.toml`, `audits.toml`, and `imports.lock` are
> machine-managed — `cargo vet` rewrites them to a canonical format and
> `--locked` fails if they drift from it (including stray hand-written
> comments). Keep human-facing documentation **here**, not inline in
> those files. Run `cargo vet fmt` after any manual edit.

## Baseline policy

`cargo vet` is a supply-chain gate: every crate in the dependency graph
must either be audited (recorded in `audits.toml`), imported from a
trusted external audit set, or explicitly exempted in `config.toml`.

The store was bootstrapped with `cargo vet init`, which records the
**entire current** dependency graph as `[[exemptions.*]]` entries (~587
crates). This is the intentional baseline: we are **not** claiming to
have hand-audited every transitive crate. The value of the gate is
**forward-looking** — a PR that pulls in a _new_ crate (or bumps one to a
version outside its exemption) makes `cargo vet` fail until a human
either audits it or consciously exempts it. That turns "a dependency
silently appeared" into a reviewable event.

## Common commands

```sh
cargo vet                       # see what's unvetted
cargo vet --locked              # CI mode: no network, fail on drift
cargo vet certify <crate> <ver> # record a real audit
cargo vet add-exemption <crate> <ver>  # baseline a new crate
cargo vet prune                 # drop exemptions no longer needed
cargo vet fmt                   # re-canonicalise the store files
```

## `npm audit` companion gate

The same CI job also runs `npm audit --omit=dev --audit-level=high`
against the **production** (shipped) dependency graph, which is clean.
Dev/build-only tooling (e.g. `electron-builder`, `node-gyp` →
`cacache`/`tar`) carries advisories that only have breaking-change
fixes and never ship in the packaged app, so the gate is intentionally
scoped to `--omit=dev` to avoid spurious failures on code that never
reaches users.
