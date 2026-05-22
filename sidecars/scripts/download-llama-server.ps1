# Download the correct llama-server binary for Windows. Selects the compute
# variant (cpu / cuda / vulkan) so the runtime ggml dispatcher has the kernel
# matching the local GPU. AVX2 is the CPU baseline and AVX-VNNI / AVX-512 VNNI
# are picked up automatically at runtime, so the CPU build is correct for every
# CPU-only Windows machine.
# Usage:
#   ./download-llama-server.ps1 -Compute cpu|cuda|vulkan [-Version <release-tag>]
[CmdletBinding()]
param(
    [ValidateSet("cpu", "cuda", "vulkan", "rocm")]
    [string]$Compute = $(if ($env:LLAMA_CPP_COMPUTE) { $env:LLAMA_CPP_COMPUTE } else { "cpu" }),
    [string]$Version = $(if ($env:LLAMA_CPP_VERSION) { $env:LLAMA_CPP_VERSION } else { "b4546" })
)

$ErrorActionPreference = "Stop"

if ($Compute -eq "rocm") {
    throw "ERROR: --compute=rocm is only supported on linux-x64; use the .sh script on Linux."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir
$SidecarDir = Join-Path $SidecarRoot "llama-server"
$ModelsJson = Join-Path $SidecarRoot "models.json"

New-Item -ItemType Directory -Force -Path $SidecarDir | Out-Null

$BinaryName = "llama-server.exe"
$TargetBinary = Join-Path $SidecarDir $BinaryName
$InstallTag = Join-Path $SidecarDir ".installed-variant"

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($Arch) {
    "X64"   { $Platform = "windows-x64" }
    "Arm64" { $Platform = "windows-arm64" }
    default { throw "Unsupported architecture: $Arch" }
}

# windows-arm64 has no GPU builds today; force CPU and warn.
if ($Platform -eq "windows-arm64" -and $Compute -ne "cpu") {
    Write-Host "INFO: windows-arm64 has no GPU builds; forcing -Compute=cpu."
    $Compute = "cpu"
}

$VariantKey = "${Platform}-${Compute}"

# Reuse cached binary only if it matches the requested variant.
if ((Test-Path $TargetBinary)) {
    $existingVariant = $null
    if (Test-Path $InstallTag) { $existingVariant = (Get-Content $InstallTag -Raw).Trim() }
    if ($existingVariant -eq $VariantKey) {
        Write-Host "llama-server ($VariantKey) already installed at $TargetBinary"
        try { & $TargetBinary --version 2>$null } catch {}
        Write-Host "To force re-download, remove $TargetBinary and re-run."
        exit 0
    }
    Write-Host "Replacing existing llama-server binary (was: $existingVariant, now: $VariantKey)"
}

# Resolve URL + checksum from the manifest when available.
$ResolvedUrl = ""
$ExpectedHash = ""
if (Test-Path $ModelsJson) {
    try {
        $manifest = Get-Content $ModelsJson -Raw | ConvertFrom-Json
        $variants = @($manifest.llama_server.variants)
        $match = $variants | Where-Object { $_.platform -eq $Platform -and $_.compute -eq $Compute } | Select-Object -First 1
        if ($match) {
            if ($match.url -and $match.url -ne "placeholder") { $ResolvedUrl = $match.url }
            if ($match.sha256 -and $match.sha256 -ne "placeholder") { $ExpectedHash = $match.sha256 }
        }
    } catch {
        # Manifest parse errors fall through to the fallback URL builder below.
    }
}

if (-not $ResolvedUrl) {
    # No usable URL in the manifest for this (platform, compute) variant.
    # The shell counterpart used to construct a fallback URL against
    # ggerganov/llama.cpp with PrismML platform names — those names don't
    # match upstream release asset naming, so the fallback 404'd in
    # practice and silently misled anyone who cleared the manifest during
    # development. Fail loudly instead with a pointer to the manifest
    # entry that needs populating.
    Write-Error "No URL configured in $ModelsJson for variant: $VariantKey. Populate llama_server.variants[].url for platform=$Platform, compute=$Compute with a real PrismML llama.cpp release asset before running this script."
    exit 1
}

Write-Host "Downloading llama.cpp $Version for $VariantKey..."
Write-Host "  URL: $ResolvedUrl"

$TempDir = Join-Path $env:TEMP "llama-download-$(Get-Random)"
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
    try { & $TargetBinary --version 2>$null } catch {}
}
finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

Write-Host "Done."
