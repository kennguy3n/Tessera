# Phase 15 Task 17 — Windows packaging verification.
#
# Verifies that the Windows electron-builder output contains both:
#   * an NSIS installer (Tessera-Setup-<ver>-x64.exe)
#   * a portable .zip (Tessera-<ver>-x64.zip), produced by the `zip` target
#     in packaging/windows/electron-builder-win.yml — which is the
#     electron-builder idiom for an extract-and-run "portable" distribution.
#     (The `portable` target is a single-exe self-extractor variant; we use
#     the `zip` target so the layout is inspectable by `Expand-Archive`
#     without running the binary, which is what this verifier does.)
#
# Inside the .zip we assert the presence of:
#   * Tessera.exe              — the Electron launcher
#   * resources\               — the asar + asar.unpacked + extraResources
#   * native\*.node            — the napi-rs bridge addon
#   * resources\app.asar       — the bundled JS/HTML (or an unpacked dir)
#
# The script is the test. Non-zero exit = fail.
#
# Invocation (from repo root, in PowerShell):
#   pwsh -File scripts/verify-windows-package.ps1
#
# Environment:
#   TESSERA_DIST_DIR   — override the dist root (default `dist/windows`).
#
# References:
#   * packaging/windows/electron-builder-win.yml
#   * scripts/smoke-test-linux.sh (sibling — Linux parity)

[CmdletBinding()]
param(
    [string]$DistDir = $env:TESSERA_DIST_DIR
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ([string]::IsNullOrWhiteSpace($DistDir)) {
    $DistDir = Join-Path -Path (Get-Location) -ChildPath "dist/windows"
}

Write-Host "==> Tessera Windows package verifier"
Write-Host "    dist dir: $DistDir"

if (-not (Test-Path -LiteralPath $DistDir -PathType Container)) {
    Write-Error "dist directory does not exist: $DistDir (run electron-builder --win first)"
    exit 2
}

# ----------------------------------------------------------------------------
# Step 1 — NSIS installer present
# ----------------------------------------------------------------------------
$nsis = Get-ChildItem -LiteralPath $DistDir -Filter "Tessera-Setup-*-x64.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
if (-not $nsis) {
    Write-Error "no NSIS installer (Tessera-Setup-*-x64.exe) found under $DistDir"
    exit 3
}
Write-Host "[OK ] NSIS installer present: $($nsis.Name) ($([math]::Round($nsis.Length / 1MB, 1)) MB)"

# ----------------------------------------------------------------------------
# Step 2 — portable .zip present
# ----------------------------------------------------------------------------
$zip = Get-ChildItem -LiteralPath $DistDir -Filter "Tessera-*-x64.zip" -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -notmatch "blockmap" } |
       Sort-Object LastWriteTime -Descending |
       Select-Object -First 1
if (-not $zip) {
    Write-Error "no portable .zip (Tessera-*-x64.zip) found under $DistDir"
    Write-Error "  electron-builder must have the `zip` target enabled in packaging/windows/electron-builder-win.yml"
    exit 4
}
Write-Host "[OK ] Portable .zip present: $($zip.Name) ($([math]::Round($zip.Length / 1MB, 1)) MB)"

# ----------------------------------------------------------------------------
# Step 3 — inspect the .zip contents.
#
# We extract into a temp dir (rather than using System.IO.Compression.ZipFile
# in-place inspection) because the .zip contains a nested app.asar which is
# a single binary blob — assertions against unpacked file paths are clearer
# than against ZipArchive entry names.
# ----------------------------------------------------------------------------
$tmp = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("tessera-verify-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    Write-Host "==> extracting $($zip.Name) → $tmp"
    Expand-Archive -LiteralPath $zip.FullName -DestinationPath $tmp -Force

    # The root of an electron-builder zip is usually `Tessera-<ver>-x64\`
    # (matches the `artifactName` template after dash-normalisation). Find
    # it dynamically rather than hard-coding the version.
    $appRoot = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    if (-not $appRoot) {
        # Some electron-builder layouts extract straight into the dest. Try
        # the dest itself if there's no single sub-folder.
        $appRoot = Get-Item -LiteralPath $tmp
    }
    Write-Host "    app root: $($appRoot.FullName)"

    # 3a — Tessera.exe at the app root
    $exe = Join-Path -Path $appRoot.FullName -ChildPath "Tessera.exe"
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
        # Some builds use lowercase or the productName-cased variant; try both.
        $alt = Join-Path -Path $appRoot.FullName -ChildPath "tessera.exe"
        if (Test-Path -LiteralPath $alt -PathType Leaf) {
            $exe = $alt
        } else {
            Write-Error "Tessera.exe not found at app root ($($appRoot.FullName))"
            Get-ChildItem -LiteralPath $appRoot.FullName | ForEach-Object {
                Write-Error "  entry: $($_.Name)"
            }
            exit 5
        }
    }
    Write-Host "[OK ] Tessera.exe present at $exe"

    # 3b — resources/ subfolder
    $resources = Join-Path -Path $appRoot.FullName -ChildPath "resources"
    if (-not (Test-Path -LiteralPath $resources -PathType Container)) {
        Write-Error "resources/ folder not present at $($appRoot.FullName)"
        exit 6
    }
    Write-Host "[OK ] resources/ folder present"

    # 3c — app.asar inside resources (or extracted app/ dir for asarUnpack=true)
    $asar = Join-Path -Path $resources -ChildPath "app.asar"
    $appDir = Join-Path -Path $resources -ChildPath "app"
    if (-not (Test-Path -LiteralPath $asar -PathType Leaf) -and -not (Test-Path -LiteralPath $appDir -PathType Container)) {
        Write-Error "neither resources/app.asar nor resources/app/ present (renderer bundle missing)"
        exit 7
    }
    if (Test-Path -LiteralPath $asar -PathType Leaf) {
        Write-Host "[OK ] resources/app.asar present"
    } else {
        Write-Host "[OK ] resources/app/ present (unpacked layout)"
    }

    # 3d — native .node addon present somewhere in the package.
    #
    # The napi-rs build emits `tessera_bridge.win32-x64-msvc.node` (or the
    # platform-specific basename). It can be either:
    #   * resources/app.asar.unpacked/native/*.node (if app.asar was used and
    #     `asarUnpack` patterns matched `native/**/*.node`), or
    #   * the app directory unpacked layout above.
    # Search recursively for any `.node` file under the app root.
    $nativeNode = Get-ChildItem -LiteralPath $appRoot.FullName -Recurse -Filter "*.node" -File -ErrorAction SilentlyContinue |
                  Select-Object -First 1
    if (-not $nativeNode) {
        Write-Error "no .node addon present under $($appRoot.FullName) — bridge would fail to load at runtime"
        exit 8
    }
    Write-Host "[OK ] native addon present: $($nativeNode.FullName.Substring($appRoot.FullName.Length + 1))"
}
finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "==> Windows package verification PASSED"
exit 0
