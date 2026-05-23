# Releasing Tessera

This guide describes the end-to-end process for cutting a new Tessera
release. The release workflow at `.github/workflows/release.yml` is
triggered when a tag matching `v*` is pushed; it builds installers for
Linux, macOS, and Windows, attaches them to a GitHub Release, and
edits the release body with a changelog generated from `git log`.

The instructions below cover the local steps a maintainer follows
before pushing the tag, and the verification steps after CI completes.

---

## 1. Make sure `main` is green

Open the [CI workflow runs on `main`](https://github.com/kennguy3n/Tessera/actions/workflows/ci.yml?query=branch%3Amain)
and confirm the most recent run on the commit you intend to tag is
green on every required gate (`Rust — ubuntu-22.04`, `TypeScript`,
`Lint`, etc.). Do **not** tag off a commit whose CI run is still
in-flight or failing.

If you need to bump the version field in `package.json` before tagging
(e.g. `0.1.0` → `0.2.0`), do that as a separate PR and let CI run on
it before continuing.

---

## 2. Run the preflight script

The preflight script is the same set of gates CI runs, plus an
`electron-builder --dir` dry-pack that catches packaging regressions
before they reach the release workflow.

> **Before the first preflight run on a fresh clone:**
> ```
> npm ci   # or `npm install` if package-lock.json is being updated
> ```
> `electron-builder` is declared as a `devDependency` of
> `apps/desktop`, so `npm ci` is what puts the pinned binary on disk.
> The packaging step uses `npx --no electron-builder ...`,
> which intentionally fails if the binary isn't already present —
> see step 9 below for the rationale.

**Linux / macOS:**

```bash
scripts/preflight.sh
```

**Windows (PowerShell):**

```powershell
.\scripts\preflight.ps1
```

The script runs:

1. `cargo fmt --all -- --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `cargo test --all`
4. `npm run lint --workspace=apps/desktop`
5. `npm run type-check --workspace=apps/desktop`
6. `npm run test --workspace=apps/desktop`
7. *(macOS / Windows only)* `npm install --no-save --no-package-lock @rollup/rollup-<plat>-<arch>`

   On macOS and Windows the script inserts a host-matching Rollup
   binary install before the build step as a workaround for
   [npm/cli#4828](https://github.com/npm/cli/issues/4828): the
   lockfile only carries the Linux entries of Rollup's per-platform
   optionalDependencies, so `npm ci` on a non-Linux host leaves
   `@rollup/rollup-darwin-*` / `@rollup/rollup-win32-*` missing and
   the next step's `vite build` would fail with a confusing
   "Cannot find module" error. CI and the release workflow carry
   the same workaround. On Linux this step is silently skipped
   because `npm ci` already installs the correct binary, so the
   per-run "[N/M]" banners show 8 steps on Linux and 9 on
   macOS/Windows.
8. `npm run build`

   Invoked at the repo root. The root `package.json` defines `build`
   as a forwarder to `npm run build --workspace=apps/desktop`, so
   this is functionally equivalent today — but it keeps preflight in
   lock-step with `.github/workflows/release.yml`, which runs the
   same root-level `npm run build`. If the root `build` script later
   grows additional steps (e.g. is changed to
   `npm run build:native && npm run build --workspace=apps/desktop`
   once the placeholder `build:native` script under `apps/desktop`
   is promoted into the chain), preflight will automatically exercise
   the new steps too rather than masking the divergence until a
   release-day failure surfaces it. The earlier `lint` / `type-check`
   / `test` steps remain workspace-scoped because CI runs them
   workspace-scoped at `.github/workflows/ci.yml:160-166`; only the
   desktop build was asymmetric, so the fix lives there.
9. `npx --no electron-builder --config packaging/electron-builder.yml --dir`

   The `--no` flag (npm 10+ canonical form, equivalent to the legacy
   `--no-install`) prevents npx from silently downloading a different
   electron-builder version into the npx cache if the workspace one
   is missing; the preflight script fails loudly in that case so the
   maintainer can install the missing dependency deliberately rather
   than ship an installer built by a floating-version binary.

A successful run ends with:

```
Preflight passed — ready to tag vX.Y.Z
```

If any step fails, the script exits non-zero and prints which step
failed. Fix and re-run before continuing.

---

## 3. Update the changelog (optional)

`release.yml` auto-generates the GitHub Release body from
`git log <previous-tag>..<new-tag>` in the `release-notes` job, so a
hand-maintained `CHANGELOG.md` is **not** required. Conventional-commit
subjects (e.g. `feat(connectors): ...`, `fix(search): ...`) make the
generated changelog readable.

If you want to ship a curated changelog instead of the raw `git log`,
create or update `CHANGELOG.md` on a separate PR before tagging and
either:

- amend the `release-notes` job to read `CHANGELOG.md` instead of
  generating from `git log`, or
- after the workflow completes, edit the GitHub Release body by hand
  with the curated notes.

The default flow (auto-generated `git log` notes) is the supported
path; treat the curated changelog as an opt-in for major releases.

---

## 4. Tag and push

```bash
# Use semantic versioning. v0.1.0 is the first stable release tag.
git tag v0.1.0
git push origin v0.1.0
```

Pushing the tag triggers `.github/workflows/release.yml`. The
workflow:

- builds the Rust + TypeScript bundle on Linux, macOS, and Windows
  runners
- runs `electron-builder` against `packaging/electron-builder.yml`
  with `--publish never`
- uploads the per-OS installer artefacts as workflow artefacts
- attaches the matching installers to the GitHub Release (creating
  the release from the tag if it does not already exist)
- regenerates the release notes from `git log` between the previous
  tag and the new one

Do not push tags from a branch other than `main`. The release
workflow does not enforce this — it trusts the maintainer — but
tagging a feature branch will produce a release whose `Source code
(zip)` link points at code that never merged.

---

## 5. Wait for `release.yml` to complete

Watch the run from
[`.github/workflows/release.yml`](https://github.com/kennguy3n/Tessera/actions/workflows/release.yml).
Each platform job produces a `tessera-<os>` artefact under "Artifacts"
and attaches the installable files to the GitHub Release.

The `release-notes` job runs after every platform job succeeds and
edits the Release body with the changelog.

---

## 6. Verify the GitHub Release page

Open the release at
`https://github.com/kennguy3n/Tessera/releases/tag/v0.1.0` and confirm:

- **Linux**: at least one of `Tessera-*.AppImage`, `Tessera_*.deb`,
  `Tessera-*.rpm` is attached.
- **macOS**: `Tessera-*.dmg` is attached (separate `x64` / `arm64`
  variants if `electron-builder` produced both).
- **Windows**: `Tessera Setup *.exe` is attached. Some configurations
  also produce a portable `.zip` — attach it too if present.
- The release body contains the auto-generated changelog (or your
  curated `CHANGELOG.md` entry, if you took the manual path in
  step 3).

If any installer is missing, the most common causes are a
platform-specific build failure in `release.yml` (check the per-OS
job logs) or an `electron-builder` config mismatch
(`packaging/electron-builder.yml`).

After verification, smoke-test at least one installer per OS by
downloading and launching it. The unsigned builds will surface an
"unidentified developer" warning on macOS Gatekeeper and a SmartScreen
prompt on Windows — that is expected for unsigned builds (see the
code-signing section below).

---

## 7. (Optional) Code signing

Tessera's release workflow already wires code-signing through
`electron-builder`'s standard environment variables. To produce
signed installers, set the following as **repository secrets** under
*Settings → Secrets and variables → Actions* before tagging:

### macOS (Apple Developer ID)

| Secret | Description |
|---|---|
| `CSC_LINK` | Base64-encoded `.p12` of your Developer ID Application certificate, or an `https://`/`s3://` URL to the file. |
| `CSC_KEY_PASSWORD` | Password used when the `.p12` was exported. |
| `APPLE_ID` | Apple ID (email) used to upload the build for notarization. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password generated at <https://appleid.apple.com>. |
| `APPLE_TEAM_ID` | (Recommended) Your 10-character Apple Developer Team ID. Required by `notarytool` for organisations with multiple teams. |

When all four (five) values are present, `electron-builder` signs the
`.app` with the Developer ID certificate and submits the resulting
`.dmg` to Apple's notary service automatically.

### Windows (Authenticode)

| Secret | Description |
|---|---|
| `CSC_LINK` | Base64-encoded `.pfx` for the Authenticode certificate, or an `https://` URL. (Re-used from the macOS row when both certificates are bundled into a single secret pair — otherwise create `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` and adjust `release.yml` to pass them as `CSC_LINK` / `CSC_KEY_PASSWORD` for the Windows job only.) |
| `CSC_KEY_PASSWORD` | `.pfx` export password. |

`electron-builder` produces signed `.exe` installers when both values
are set on the Windows runner.

### Linux

Linux installers (`.AppImage`, `.deb`, `.rpm`) are not Authenticode-
or Developer-ID signed — the standard distribution mechanism is the
upstream package signing key, which we do not currently maintain. If
you need GPG-signed `.deb` / `.rpm` artefacts, configure
`electron-builder`'s `deb.signByDefault` / `rpm.signByDefault`
options in `packaging/electron-builder.yml` and add the matching
private key as a repository secret.

### Verifying signing took effect

After the release workflow completes:

- **macOS**: `codesign --verify --deep --strict --verbose=2
  Tessera-*.dmg` and `spctl --assess --type execute
  /Applications/Tessera.app` should both return success.
- **Windows**: Right-click the installer → *Properties → Digital
  Signatures* should show your certificate.

If signing was not configured, the workflow still produces installable
unsigned artefacts — they just show OS-level "unidentified developer"
warnings on first launch.

---

## 8. Post-release

- Open the release and **uncheck "This is a pre-release"** if you
  ticked it for an RC. The auto-created release is `latest` by default
  unless it is the very first one.
- Announce the release where appropriate (project channel, README
  badge updates, etc.).
- If you discover a regression, prefer cutting a patch release
  (`v0.1.1`) over re-tagging. Re-tagging an existing version corrupts
  consumers' caches and is rejected by GitHub once a release is
  published.

---

## Quick reference

```bash
# 1. Make sure main is green
gh run list --workflow=ci.yml --branch=main --limit=1

# 2. Preflight
scripts/preflight.sh        # or: scripts/preflight.ps1

# 3. (Optional) Update CHANGELOG.md as a separate PR

# 4. Tag and push
git tag v0.1.0
git push origin v0.1.0

# 5. Wait for release.yml
gh run list --workflow=release.yml --limit=1

# 6. Verify
gh release view v0.1.0
```
