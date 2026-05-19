# Download the correct llama-server binary for Windows.
# Places binary at sidecars\llama-server\llama-server.exe

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarDir = Join-Path (Split-Path -Parent $ScriptDir) "llama-server"
$Version = if ($env:LLAMA_CPP_VERSION) { $env:LLAMA_CPP_VERSION } else { "b4546" }

New-Item -ItemType Directory -Force -Path $SidecarDir | Out-Null

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
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath -UseBasicParsing

    $ExtractDir = Join-Path $TempDir "extracted"
    Expand-Archive -Path $ArchivePath -DestinationPath $ExtractDir -Force

    $BinaryName = "llama-server.exe"
    $FoundBinary = Get-ChildItem -Path $ExtractDir -Recurse -Filter $BinaryName | Select-Object -First 1

    if (-not $FoundBinary) {
        throw "Could not find $BinaryName in archive"
    }

    Copy-Item $FoundBinary.FullName (Join-Path $SidecarDir $BinaryName) -Force
    Write-Host "Installed: $(Join-Path $SidecarDir $BinaryName)"
}
finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

Write-Host "Done."
