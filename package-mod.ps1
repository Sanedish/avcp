# =============================================================================
# Packages the Web Control Panel into a BeamNG-compatible mod zip.
#
# The resulting zip contains ONLY additive UI files under ui/webcontrolpanel/.
# It does not touch or override any original game file, performs no writes at
# runtime, and runs entirely from inside the zip (read-only) -- so it complies
# with BeamNG's modding / repository rules. Drop the zip into <userfolder>/mods/
# and the game auto-mounts it.
#
# IMPORTANT: BeamNG's virtual file system (physfs) requires FORWARD-SLASH path
# separators inside the zip. PowerShell's built-in Compress-Archive writes
# BACK-slashes, which makes the mod fail to mount. This script therefore builds
# the archive with System.IO.Compression and explicit '/' entry names.
# =============================================================================
param(
    [string]$OutFile = (Join-Path $PSScriptRoot "LunaMattinsAVCP.zip")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$src = $PSScriptRoot

# Files that make up the mod (relative to this folder). README is optional docs.
$files = @(
    "index.html",
    "css/style.css",
    "js/settings.js",
    "js/splash.js",
    "js/bridge.js",
    "js/remote.js",
    "js/gauges.js",
    "js/customize.js",
    "js/datalab.js",
    "js/app.js",
    "README.md",
    "CHANGELOG.md"
)

# Auto-include everything under images/ (credits PFPs, art, icons, …) and
# media/ (intro splash videos + credits art) so new assets are bundled without
# editing this list. Paths are made relative with FORWARD slashes for the
# in-game VFS. If the intro .webm files are stripped from a build to save
# size, the panel falls back to streaming them from the Malo Interactive CDN
# once on first launch (see js/splash.js).
foreach ($assetDir in @("images", "media")) {
    $dir = Join-Path $src $assetDir
    if (Test-Path $dir) {
        Get-ChildItem -Path $dir -File -Recurse | ForEach-Object {
            $files += ($_.FullName.Substring($src.Length + 1) -replace '\\', '/')
        }
    }
}

if (Test-Path $OutFile) { Remove-Item $OutFile -Force }

$zip = [System.IO.Compression.ZipFile]::Open($OutFile, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        $from = Join-Path $src ($f -replace '/', '\')
        if (-not (Test-Path $from)) { Write-Warning "missing: $f"; continue }
        # entry name uses the in-game VFS path with FORWARD slashes
        $entryName = "ui/webcontrolpanel/" + ($f -replace '\\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $from, $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $zip.Dispose()
}

Write-Host ""
Write-Host "Built mod:" -ForegroundColor Green
Write-Host "  $OutFile"
Write-Host ""
Write-Host "Install: copy it into <userfolder>\mods\  (the game auto-mounts it,"
Write-Host "         or restart the game). Then open:"
Write-Host "         http://localhost:8084/ui/webcontrolpanel/index.html"
Write-Host ""
Write-Host "NOTE: if you also have the loose ui\webcontrolpanel\ folder in your"
Write-Host "      user folder, remove it so the files are not mounted twice."
