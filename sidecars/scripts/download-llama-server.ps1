# Download the correct llama-server binary for Windows.
# Places binary at sidecars\llama-server\llama-server.exe
# Reads model manifest from sidecars\models.json for checksums.
# Skips download if valid binary already exists.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir
$SidecarDir = Join-Path $SidecarRoot "llama-server"
$ModelsJson = Join-Path $SidecarRoot "models.json"
$Version = if ($env:LLAMA_CPP_VERSION) { $env:LLAMA_CPP_VERSION } else { "b4546" }

New-Item -ItemType Directory -Force -Path $SidecarDir | Out-Null

$BinaryName = "llama-server.exe"
$TargetBinary = Join-Path $SidecarDir $BinaryName

# Check if binary already exists
if (Test-Path $TargetBinary) {
    Write-Host "llama-server already installed at $TargetBinary"
    try { & $TargetBinary --version 2>$null } catch {}
    Write-Host "To force re-download, remove $TargetBinary and re-run."
    exit 0
}

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($Arch) {
    "X64"   { $Platform = "win-x64" }
    "Arm64" { $Platform = "win-arm64" }
    default { throw "Unsupported architecture: $Arch" }
}

$BaseUrl = "https://github.com/ggerganov/llama.cpp/releases/download/$Version"
$ArchiveName = "llama-${Version}-bin-${Platform}.zip"
$DownloadUrl = "$BaseUrl/$ArchiveName"

Write-Host "Downloading llama.cpp $Version for $Platform..."
Write-Host "  URL: $DownloadUrl"

$TempDir = Join-Path $env:TEMP "llama-download-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    $ArchivePath = Join-Path $TempDir $ArchiveName

    # Download with retry
    $retryCount = 0
    $maxRetries = 3
    while ($retryCount -lt $maxRetries) {
        try {
            Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath -UseBasicParsing
            break
        }
        catch {
            $retryCount++
            if ($retryCount -eq $maxRetries) { throw }
            Write-Host "Download failed, retrying ($retryCount/$maxRetries)..."
            Start-Sleep -Seconds (5 * $retryCount)
        }
    }

    # Verify checksum if available in models.json
    if (Test-Path $ModelsJson) {
        try {
            $manifest = Get-Content $ModelsJson -Raw | ConvertFrom-Json
            $serverChecksums = $manifest.server_checksums
            if ($serverChecksums -and $serverChecksums.$Platform) {
                $expectedChecksum = $serverChecksums.$Platform
                if ($expectedChecksum -match "^sha256:(.+)$") {
                    $expectedHash = $Matches[1]
                    if ($expectedHash -ne "placeholder-update-with-real-hash-after-model-publish") {
                        Write-Host "Verifying checksum..."
                        $actualHash = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLower()
                        if ($actualHash -ne $expectedHash.ToLower()) {
                            throw "Checksum mismatch! Expected: $expectedHash, Actual: $actualHash"
                        }
                        Write-Host "Checksum verified."
                    }
                    else {
                        Write-Host "No server checksum in manifest - skipping verification."
                    }
                }
            }
            else {
                Write-Host "No server checksum in manifest - skipping verification."
            }
        }
        catch [System.Management.Automation.PropertyNotFoundException] {
            Write-Host "No server checksums in manifest - skipping verification."
        }
    }

    $ExtractDir = Join-Path $TempDir "extracted"
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $FoundBinary = Get-ChildItem -Path $ExtractDir -Recurse -Filter $BinaryName | Select-Object -First 1

    if (-not $FoundBinary) {
        throw "Could not find $BinaryName in archive"
    }

    Copy-Item $FoundBinary.FullName $TargetBinary -Force
    Write-Host "Installed: $TargetBinary"
    try { & $TargetBinary --version 2>$null } catch {}
}
finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

Write-Host "Done."
