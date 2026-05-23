<#
.SYNOPSIS
    Tessera pre-release preflight (Windows / PowerShell).

.DESCRIPTION
    Runs every gate that CI runs before a tagged release, plus an
    `electron-builder --dir` dry-pack so packaging regressions are
    caught before a `v*` tag is pushed (which would trigger the real
    release workflow). Each step is wrapped so a failure surfaces
    the failing step's name and the script exits non-zero — no
    silent skips.

.PARAMETER SkipPackage
    Skip the electron-builder --dir dry-pack step. Useful on
    constrained machines or CI legs that can't run
    electron-builder; CI does its own packaging in the release
    workflow either way.

.PARAMETER Version
    Override the version string used in the final "ready to tag"
    summary; defaults to the `version` field in package.json.

.EXAMPLE
    .\scripts\preflight.ps1
    Run the full preflight against the current working copy.

.EXAMPLE
    $env:TESSERA_PREFLIGHT_SKIP_PACKAGE = '1'; .\scripts\preflight.ps1
    Same as above, but skip the electron-builder dry-pack.

.NOTES
    Exit codes:
      0       — every step passed; safe to tag the printed version.
      non-zero — the first failing step's exit code.
#>
[CmdletBinding()]
param(
    [switch]$SkipPackage,
    [string]$Version
)

# Stop on any error so the per-step wrapper below can surface the
# failure location cleanly. We deliberately turn this *off* for
# individual step bodies and re-check $LASTEXITCODE ourselves so
# the failure banner has the correct step name.
$ErrorActionPreference = 'Stop'

# Mirror the CI workflow's global RUSTFLAGS (the workflow-level
# `env:` block in .github/workflows/ci.yml). Without this,
# `cargo test --all` (and any plain `cargo build` it triggers) would
# only emit warnings while CI treats those same warnings as errors —
# a release-day surprise we exist to prevent. We append rather than
# overwrite so a developer's pre-existing RUSTFLAGS (e.g. for
# target-cpu tuning) is preserved.
# PowerShell 5.1 lacks the `??` null-coalescing operator, so we
# explicitly normalise an unset env var to the empty string before
# concatenating. The Trim() ensures we don't leave a leading space
# when RUSTFLAGS was previously unset.
$existingRustflags = if ($env:RUSTFLAGS) { $env:RUSTFLAGS } else { '' }
# Detect whether the user already has `-D warnings` in their RUSTFLAGS
# so we don't emit `... -D warnings -D warnings`. rustc deduplicates
# flags so the repeat is harmless, but it makes CI logs noisy and the
# dedup is essentially free. The regex matches on token boundaries
# (`(^|\s)-D\s+warnings(\s|$)`) so we don't false-positive on e.g.
# `-D warnings-as-deny` or any future flag that prefixes `warnings`.
if ($existingRustflags -match '(^|\s)-D\s+warnings(\s|$)') {
    $env:RUSTFLAGS = $existingRustflags
} else {
    $env:RUSTFLAGS = ("{0} -D warnings" -f $existingRustflags).Trim()
}

# Always run from the repo root so relative paths in cargo / npm /
# electron-builder resolve correctly even when the script is invoked
# from a subdirectory.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = (Resolve-Path (Join-Path $ScriptDir '..')).Path
Set-Location $RepoRoot

# ----------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------

# Use Write-Host with colours for interactive sessions; on CI (no
# host UI) PowerShell still honours -ForegroundColor on most agents
# and gracefully degrades elsewhere.
function Write-StepHeader {
    param([int]$Index, [int]$Total, [string]$Label, [string]$Command)
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $Index, $Total, $Label) -ForegroundColor Cyan
    Write-Host ("    {0}" -f $Command) -ForegroundColor DarkGray
}

function Write-Success {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Green
}

function Write-Failure {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
}

# ----------------------------------------------------------------------
# Step model
# ----------------------------------------------------------------------

# Each step is a hashtable with a label and a script block. We
# collect them up front so the step headers can show "1/N" /
# "2/N" / ... correctly even when SkipPackage is set.
$Steps = New-Object System.Collections.Generic.List[hashtable]

function Add-Step {
    # The Action scriptblock is expected to invoke at most ONE native
    # command (cargo / npm / npx). Invoke-AllSteps reads
    # $LASTEXITCODE after the block to decide pass/fail — which means
    # only the *last* native command in a multi-command Action would
    # contribute to that decision, exactly mirroring bash's behaviour
    # without `-e`. The bash side of this preflight runs each step
    # under `bash -e -o pipefail -c` so `cmd1; cmd2` fails on cmd1;
    # there is no equivalent one-line PowerShell knob, so the rule
    # is enforced socially: if you genuinely need to chain native
    # commands inside a single step, write the Action as
    #
    #   { cmd1 args; if ($LASTEXITCODE -ne 0) { return }
    #     cmd2 args }
    #
    # so the second command is gated on the first's success. The
    # final $LASTEXITCODE the runner checks will then either be the
    # first command's non-zero exit (failure) or the second's zero
    # exit (success).
    param(
        [string]$Label,
        [string]$Command,
        [ScriptBlock]$Action
    )
    $Steps.Add(@{
        Label   = $Label
        Command = $Command
        Action  = $Action
    }) | Out-Null
}

function Invoke-AllSteps {
    $total = $Steps.Count
    for ($i = 0; $i -lt $total; $i++) {
        $step  = $Steps[$i]
        $index = $i + 1
        Write-StepHeader -Index $index -Total $total -Label $step.Label -Command $step.Command

        # Reset $LASTEXITCODE before invoking the step. $LASTEXITCODE
        # is a session-wide variable that only native processes update
        # — if a future step's Action ran only PowerShell cmdlets (no
        # cargo/npm/npx), the post-step check below would otherwise
        # read the leftover code from the *previous* step's native
        # command and either declare a clean step failed or a failed
        # step clean. Resetting here keeps the contract simple: a
        # step is "successful" iff every native command in its Action
        # exited 0 (or there were no native commands and no
        # terminating errors).
        $global:LASTEXITCODE = 0

        # Disable -ErrorActionPreference 'Stop' inside the step
        # so we can detect non-zero exit codes from native
        # processes (cargo / npm / npx) ourselves rather than
        # having PowerShell short-circuit.
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        # Track whether the dispatched command actually launched. A
        # command-not-found (e.g. cargo is not installed) raises a
        # CommandNotFoundException without ever updating
        # $LASTEXITCODE, so without this guard the bash version
        # (which sees exit 127 from `bash -o pipefail -c`) would be
        # strictly more robust than the PowerShell one.
        $stepFailure = $null
        try {
            & $step.Action
        }
        catch [System.Management.Automation.CommandNotFoundException] {
            $stepFailure = $_
        }
        catch {
            # Re-surface any other terminating error from the step
            # body so we can convert it to a non-zero exit. Without
            # this catch, ErrorActionPreference='Continue' inside
            # the step would let unhandled exceptions bubble
            # straight out of the script with no failure banner.
            $stepFailure = $_
        }
        finally {
            $ErrorActionPreference = $prevPref
        }

        if ($null -ne $stepFailure) {
            Write-Host ''
            Write-Failure (
                "FAILED at step {0}/{1}: {2} ({3})" -f $index, $total, $step.Label, $stepFailure.Exception.Message
            )
            # Use 127 to mirror bash's command-not-found exit code
            # when that's what we caught; fall back to 1 for any
            # other terminating error.
            $exitCode = if ($stepFailure.Exception -is [System.Management.Automation.CommandNotFoundException]) { 127 } else { 1 }
            exit $exitCode
        }

        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 0 }
        if ($code -ne 0) {
            Write-Host ''
            Write-Failure (
                "FAILED at step {0}/{1}: {2} (exit {3})" -f $index, $total, $step.Label, $code
            )
            exit $code
        }
    }
}

# ----------------------------------------------------------------------
# Version detection
# ----------------------------------------------------------------------

# Returns $true if $Value is a usable version string (non-empty and
# not the JSON sentinels `undefined` / `null` that ConvertFrom-Json
# would surface if package.json lacked a `version` field).
function Test-VersionUsable {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return ($Value -notin @('undefined', 'null'))
}

function Resolve-Version {
    # Precedence (highest to lowest):
    #   1. `-Version` CLI parameter — explicit, scoped to a single
    #      invocation; if the maintainer typed it on the command line
    #      they meant it for THIS run.
    #   2. `$env:TESSERA_PREFLIGHT_VERSION` — shell-scoped, less
    #      explicit than a CLI arg but still a deliberate override.
    #   3. `package.json` `version` field — the source of truth.
    #   4. Placeholder `X.Y.Z` — only reached if package.json is
    #      missing or malformed; the build steps would fail loudly
    #      well before the summary line is printed.
    #
    # The bash script omits step 1 (POSIX shells don't support named
    # parameters cleanly), so its precedence is 2 → 3 → 4. Adding a
    # CLI arg to bash would mean recreating `getopts` boilerplate
    # for a script that runs maybe once per release; the slight
    # asymmetry is deliberate. The mental model holds either way:
    # "most explicit wins, falling back to package.json".
    #
    # `$PSBoundParameters` here would scope to *this* function (which
    # declares no parameters), not the script. The script-level
    # `-Version` parameter is reachable via the parent scope because
    # PowerShell functions inherit the caller's variables — so we test
    # the variable itself rather than the (empty) function-local
    # PSBoundParameters.
    if (Test-VersionUsable $script:Version) {
        return $script:Version
    }
    if (Test-VersionUsable $env:TESSERA_PREFLIGHT_VERSION) {
        return $env:TESSERA_PREFLIGHT_VERSION
    }
    try {
        $pkg = Get-Content -Raw -Path (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
        if ($pkg.PSObject.Properties.Name -contains 'version') {
            $candidate = [string]$pkg.version
            if (Test-VersionUsable $candidate) { return $candidate }
        }
    }
    catch {
        # Fall through to the placeholder; the build steps will fail
        # loudly if package.json is genuinely missing or malformed.
    }
    return 'X.Y.Z'
}

# ----------------------------------------------------------------------
# Step registration
# ----------------------------------------------------------------------

# 1) Rust formatting check — same command the CI workflow runs in
#    the "Check formatting" step of the `rust` job.
Add-Step `
    -Label   'Rust format check (cargo fmt --all -- --check)' `
    -Command 'cargo fmt --all -- --check' `
    -Action  { cargo fmt --all -- --check }

# 2) Rust clippy with warnings-as-errors — same command the CI
#    workflow runs in the "Clippy" step of the `rust` job
#    (RUSTFLAGS="-D warnings" is set globally in the workflow's
#    top-level `env:` block; we propagate it above).
Add-Step `
    -Label   'Rust clippy (cargo clippy --all-targets --all-features -- -D warnings)' `
    -Command 'cargo clippy --all-targets --all-features -- -D warnings' `
    -Action  { cargo clippy --all-targets --all-features -- -D warnings }

# 3) Rust workspace tests.
Add-Step `
    -Label   'Rust tests (cargo test --all)' `
    -Command 'cargo test --all' `
    -Action  { cargo test --all }

# 4) Desktop renderer / Electron lint.
Add-Step `
    -Label   'Desktop lint (npm run lint --workspace=apps/desktop)' `
    -Command 'npm run lint --workspace=apps/desktop' `
    -Action  { npm run lint --workspace=apps/desktop }

# 5) Desktop TypeScript type-check.
Add-Step `
    -Label   'Desktop type-check (npm run type-check --workspace=apps/desktop)' `
    -Command 'npm run type-check --workspace=apps/desktop' `
    -Action  { npm run type-check --workspace=apps/desktop }

# 6) Desktop unit / component tests (Vitest).
Add-Step `
    -Label   'Desktop tests (npm run test --workspace=apps/desktop)' `
    -Command 'npm run test --workspace=apps/desktop' `
    -Action  { npm run test --workspace=apps/desktop }

# 7) Build the bundle electron-builder will consume so the
#    dry-pack runs against current artefacts, not a stale one.
Add-Step `
    -Label   'Desktop build (npm run build --workspace=apps/desktop)' `
    -Command 'npm run build --workspace=apps/desktop' `
    -Action  { npm run build --workspace=apps/desktop }

# 8) electron-builder dry-pack. `--dir` skips installer creation
#    but still assembles the full app bundle, catching packaging
#    regressions before a release tag is pushed.
$skip = $SkipPackage -or ($env:TESSERA_PREFLIGHT_SKIP_PACKAGE -eq '1')
if (-not $skip) {
    Add-Step `
        -Label   'Electron bundle dry-pack (electron-builder --dir)' `
        -Command 'npx --no-install electron-builder --config packaging/electron-builder.yml --dir' `
        -Action  { npx --no-install electron-builder --config packaging/electron-builder.yml --dir }
}

# ----------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------

$detectedVersion = Resolve-Version
Write-Host ("Tessera preflight — version v{0}" -f $detectedVersion) -ForegroundColor Cyan

Invoke-AllSteps

Write-Host ''
Write-Success ("Preflight passed — ready to tag v{0}" -f $detectedVersion)
