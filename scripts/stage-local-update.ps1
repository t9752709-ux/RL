$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$artifactRoot = Split-Path -Parent $projectRoot
$installerName = "Overlay-RL-Setup-v$($package.version).exe"
$installerPath = Join-Path $artifactRoot $installerName
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "Installateur introuvable après compilation : $installerPath"
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash([System.IO.File]::ReadAllBytes($installerPath))
  $checksum = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
} finally {
  $sha256.Dispose()
}
$checksumPath = "$installerPath.sha256"
[System.IO.File]::WriteAllText($checksumPath, "$checksum  $installerName`n", [System.Text.UTF8Encoding]::new($false))
$updateDirectory = Join-Path $env:LOCALAPPDATA 'Rally\Updates'
New-Item -ItemType Directory -Path $updateDirectory -Force | Out-Null
Copy-Item -LiteralPath $installerPath -Destination (Join-Path $updateDirectory 'Rally-Update.exe') -Force
$manifest = [ordered]@{
  version = [string]$package.version
  installer = 'Rally-Update.exe'
} | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $updateDirectory 'latest.json'), $manifest, [System.Text.UTF8Encoding]::new($false))
Write-Output "Mise à jour Overlay RL $($package.version) prête dans $updateDirectory"
