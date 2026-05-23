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

        # Disable -ErrorActionPreference 'Stop' inside the step
        # so we can detect non-zero exit codes from native
        # processes (cargo / npm / npx) ourselves rather than
        # having PowerShell short-circuit.
        $prevPref = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $step.Action
        }
        finally {
            $ErrorActionPreference = $prevPref
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

function Resolve-Version {
    # NOTE: `$PSBoundParameters` here would scope to *this* function (which
    # declares no parameters), not the script. The script-level `-Version`
    # parameter is reachable via the parent scope because PowerShell
    # functions inherit the caller's variables — so we test the variable
    # itself rather than the (empty) function-local PSBoundParameters.
    if ($script:Version) {
        return $script:Version
    }
    if ($env:TESSERA_PREFLIGHT_VERSION) {
        return $env:TESSERA_PREFLIGHT_VERSION
    }
    try {
        $pkg = Get-Content -Raw -Path (Join-Path $RepoRoot 'package.json') | ConvertFrom-Json
        if ($pkg.version) { return [string]$pkg.version }
    }
    catch {
        # Fall through to the placeholder; the build steps will fail
        # loudly if package.json is genuinely missing.
    }
    return 'X.Y.Z'
}

# ----------------------------------------------------------------------
# Step registration
# ----------------------------------------------------------------------

# 1) Rust formatting check — same command CI runs (ci.yml line 103).
Add-Step `
    -Label   'Rust format check (cargo fmt --all -- --check)' `
    -Command 'cargo fmt --all -- --check' `
    -Action  { cargo fmt --all -- --check }

# 2) Rust clippy with warnings-as-errors — same command CI runs
#    (ci.yml line 104; RUSTFLAGS="-D warnings" is set globally there).
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
