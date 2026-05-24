# Download the correct sd-server binary (stable-diffusion.cpp's HTTP server)
# for Windows. Image generation is GPU-only: CPU diffusion is too slow to
# be usable (a single FLUX.2-klein image takes >5 min on CPU vs. ~15 s on
# GPU), so the manifest deliberately omits the cpu variant. This script
# enforces the same invariant — there is no cpu fallback.
#
# Usage:
#   ./download-sd-server.ps1 -Compute cuda|vulkan [-Version <release-tag>]
[CmdletBinding()]
param(
    [ValidateSet("cuda", "vulkan", "rocm", "metal")]
    [string]$Compute = $(if ($env:SD_SERVER_COMPUTE) { $env:SD_SERVER_COMPUTE } else { "" }),
    [string]$Version = $(if ($env:SD_SERVER_VERSION) { $env:SD_SERVER_VERSION } else { "master-c2f6c81" })
)

$ErrorActionPreference = "Stop"

if (-not $Compute) {
    throw "ERROR: -Compute is required (cuda|vulkan). Diffusion is GPU-only — there is no cpu variant."
}
if ($Compute -eq "rocm") {
    throw "ERROR: -Compute=rocm is only supported on linux-x64; use the .sh script on Linux."
}
if ($Compute -eq "metal") {
    throw "ERROR: -Compute=metal is only supported on macos-apple-silicon; use the .sh script on macOS."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir
$SidecarDir = Join-Path $SidecarRoot "sd-server"
$ModelsJson = Join-Path $SidecarRoot "models.json"

New-Item -ItemType Directory -Force -Path $SidecarDir | Out-Null

$BinaryName = "sd-server.exe"
$TargetBinary = Join-Path $SidecarDir $BinaryName
$InstallTag = Join-Path $SidecarDir ".installed-variant"

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($Arch) {
    "X64"   { $Platform = "windows-x64" }
    "Arm64" {
        # stable-diffusion.cpp doesn't ship a windows-arm64 build today.
        # Fail clearly rather than chasing a 404.
        throw "ERROR: windows-arm64 is not supported for diffusion (no sd-server build available). Use windows-x64 with a discrete GPU."
    }
    default { throw "Unsupported architecture: $Arch" }
}

$VariantKey = "${Platform}-${Compute}"

if ((Test-Path $TargetBinary)) {
    $existingVariant = $null
    if (Test-Path $InstallTag) { $existingVariant = (Get-Content $InstallTag -Raw).Trim() }
    if ($existingVariant -eq $VariantKey) {
        Write-Host "sd-server ($VariantKey) already installed at $TargetBinary"
        try { & $TargetBinary --help 2>$null | Select-Object -First 1 } catch {}
        Write-Host "To force re-download, remove $TargetBinary and re-run."
        exit 0
    }
    Write-Host "Replacing existing sd-server binary (was: $existingVariant, now: $VariantKey)"
}

# Resolve URL + checksum from the diffusion_server block of the manifest.
$ResolvedUrl = ""
$ExpectedHash = ""
if (Test-Path $ModelsJson) {
    try {
        $manifest = Get-Content $ModelsJson -Raw | ConvertFrom-Json
        $variants = @($manifest.diffusion_server.variants)
        $match = $variants | Where-Object { $_.platform -eq $Platform -and $_.compute -eq $Compute } | Select-Object -First 1
        if ($match) {
            if ($match.url -and $match.url -ne "placeholder") { $ResolvedUrl = $match.url }
            if ($match.sha256 -and $match.sha256 -ne "placeholder") { $ExpectedHash = $match.sha256 }
        }
    } catch {
        # Manifest parse errors fall through to the explicit-failure branch
        # below — we don't construct a fallback URL because there's no
        # naming convention we could safely guess for the diffusion sidecar.
    }
}

if (-not $ResolvedUrl) {
    Write-Error "No URL configured in $ModelsJson for variant: $VariantKey. Populate diffusion_server.variants[].url for platform=$Platform, compute=$Compute with a real stable-diffusion.cpp release asset before running this script."
    exit 1
}

Write-Host "Downloading stable-diffusion.cpp $Version for $VariantKey..."
Write-Host "  URL: $ResolvedUrl"

$TempDir = Join-Path $env:TEMP "sd-server-download-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    $ArchivePath = Join-Path $TempDir (Split-Path $ResolvedUrl -Leaf)

    $retryCount = 0
    $maxRetries = 3
    while ($retryCount -lt $maxRetries) {
        try {
            Invoke-WebRequest -Uri $ResolvedUrl -OutFile $ArchivePath -UseBasicParsing
            break
        }
        catch {
            $retryCount++
            if ($retryCount -eq $maxRetries) { throw }
            Write-Host "Download failed, retrying ($retryCount/$maxRetries)..."
            Start-Sleep -Seconds (5 * $retryCount)
        }
    }

    if ($ExpectedHash) {
        Write-Host "Verifying checksum..."
        $actualHash = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLower()
        if ($actualHash -ne $ExpectedHash.ToLower()) {
            throw "Checksum mismatch! Expected: $ExpectedHash, Actual: $actualHash"
        }
        Write-Host "Checksum verified."
    }
    else {
        Write-Host "No checksum in manifest for $VariantKey - skipping verification."
    }

    $ExtractDir = Join-Path $TempDir "extracted"
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $FoundBinary = Get-ChildItem -Path $ExtractDir -Recurse -Filter $BinaryName | Select-Object -First 1
    if (-not $FoundBinary) {
        throw "Could not find $BinaryName in archive"
    }

    Copy-Item $FoundBinary.FullName $TargetBinary -Force
    Set-Content -Path $InstallTag -Value $VariantKey -NoNewline
    Write-Host "Installed: $TargetBinary (variant: $VariantKey)"
    try { & $TargetBinary --help 2>$null | Select-Object -First 1 } catch {}
}
finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

Write-Host "Done."
