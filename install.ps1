# tanka-wm installer for Windows (PowerShell)
#
# Usage:
#   irm https://raw.githubusercontent.com/Shanda-Group-Ltd/tanka-work-memory-cli/dev/install.ps1 | iex
#
# Environment variables:
#   TANKA_WM_VERSION      pin a specific version (e.g. v1.3.1); default: latest
#   TANKA_WM_INSTALL_DIR  install directory; default: ~\.local\bin

$ErrorActionPreference = "Stop"

$GitHubRepo = "Shanda-Group-Ltd/tanka-work-memory-cli"
$GitHubApi = "https://api.github.com/repos/$GitHubRepo/releases"

# ── Platform detection ───────────────────────────────────────────────

function Get-Platform {
    $arch = if ([Environment]::Is64BitOperatingSystem) {
        if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or
            (Get-CimInstance Win32_Processor).Architecture -eq 12) {
            "arm64"
        } else {
            "x64"
        }
    } else {
        throw "32-bit systems are not supported"
    }
    return "windows-$arch"
}

# ── Version resolution ───────────────────────────────────────────────

function Resolve-Version {
    $version = $env:TANKA_WM_VERSION
    if ($version) {
        if (-not $version.StartsWith("v")) { $version = "v$version" }
        Write-Host "info  pinned version: $version"
    } else {
        Write-Host "info  resolving latest version..."
        $release = Invoke-RestMethod -Uri "$GitHubApi/latest" -Headers @{ "User-Agent" = "tanka-wm-installer" }
        $version = $release.tag_name
        if (-not $version) { throw "failed to resolve latest version from GitHub API" }
        Write-Host "info  latest version: $version"
    }
    return $version
}

# ── Checksum verification ────────────────────────────────────────────

function Test-Checksum {
    param([string]$File, [string]$Expected)
    $actual = (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $Expected) {
        throw "checksum mismatch for $(Split-Path $File -Leaf)`n  expected: $Expected`n    actual: $actual"
    }
    Write-Host "  ok  checksum verified" -ForegroundColor Green
}

# ── Main ─────────────────────────────────────────────────────────────

function Install-TankaWm {
    Write-Host "`ntanka-wm installer`n" -ForegroundColor White

    $platform = Get-Platform
    $assetName = "tanka-wm-$platform.exe"
    Write-Host "info  platform: $platform"

    $version = Resolve-Version
    $downloadBase = "https://github.com/$GitHubRepo/releases/download/$version"

    $installDir = if ($env:TANKA_WM_INSTALL_DIR) {
        $env:TANKA_WM_INSTALL_DIR
    } else {
        Join-Path $env:USERPROFILE ".local\bin"
    }
    $installPath = Join-Path $installDir "tanka-wm.exe"

    # Check existing
    if (Test-Path $installPath) {
        try {
            $existingVer = & $installPath --version 2>$null
            Write-Host "info  existing installation: $existingVer"
        } catch {}
    }

    # Create install directory
    if (-not (Test-Path $installDir)) {
        New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    }

    $tmpDir = Join-Path ([IO.Path]::GetTempPath()) "tanka-wm-install-$([guid]::NewGuid().ToString('N').Substring(0,8))"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    try {
        # Download checksums
        Write-Host "info  downloading checksums..."
        $checksumFile = Join-Path $tmpDir "checksums-sha256.txt"
        Invoke-WebRequest -Uri "$downloadBase/checksums-sha256.txt" -OutFile $checksumFile -UseBasicParsing

        # Extract expected hash
        $checksumContent = Get-Content $checksumFile -Raw
        $match = [regex]::Match($checksumContent, "([a-f0-9]{64})\s+$([regex]::Escape($assetName))")
        if (-not $match.Success) {
            throw "no checksum found for $assetName in checksums-sha256.txt`navailable:`n$checksumContent"
        }
        $expectedHash = $match.Groups[1].Value

        # Download binary
        Write-Host "info  downloading $assetName..."
        $binaryFile = Join-Path $tmpDir $assetName
        Invoke-WebRequest -Uri "$downloadBase/$assetName" -OutFile $binaryFile -UseBasicParsing

        # Verify
        Test-Checksum -File $binaryFile -Expected $expectedHash

        # Install
        Move-Item -Path $binaryFile -Destination $installPath -Force
        Write-Host "  ok  installed $version to $installPath" -ForegroundColor Green

        # Verify it runs
        try {
            $installedVer = & $installPath --version 2>$null
            Write-Host "  ok  $installedVer" -ForegroundColor Green
        } catch {
            Write-Host "warn  binary installed but failed to run" -ForegroundColor Yellow
        }

        # PATH check
        $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        if ($userPath -notlike "*$installDir*") {
            Write-Host "warn  $installDir is not in your PATH" -ForegroundColor Yellow
            $newPath = "$installDir;$userPath"
            [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
            $env:PATH = "$installDir;$env:PATH"
            Write-Host "  ok  added to user PATH (restart your terminal to take effect)" -ForegroundColor Green
        }

    } finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Host "`ndone! Run 'tanka-wm --help' to get started.`n" -ForegroundColor Green
}

Install-TankaWm
