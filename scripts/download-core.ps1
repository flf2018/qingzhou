param([Parameter(Mandatory=$true)][ValidateSet('Xray','sing-box')][string]$CoreName)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifest = Get-Content (Join-Path $projectRoot 'vendor/cores/manifest.json') -Raw | ConvertFrom-Json
$coreInfo = $manifest.$CoreName
$cacheRoot = Join-Path $projectRoot '.cache/cores'
$coreRoot = Join-Path $projectRoot "vendor/cores/$($coreInfo.directory)"
New-Item -ItemType Directory -Path $cacheRoot,$coreRoot -Force | Out-Null
$archivePath = Join-Path $cacheRoot "$($coreInfo.directory)-$($coreInfo.version).zip"
if (!(Test-Path -LiteralPath $archivePath) -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $coreInfo.sha256) {
    Invoke-WebRequest -Uri $coreInfo.url -OutFile $archivePath -TimeoutSec 300
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $coreInfo.sha256) { throw 'Core archive SHA256 mismatch' }
$extractRoot = Join-Path $cacheRoot "$($coreInfo.directory)-$($coreInfo.version)"
Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
$coreFile = Get-ChildItem -LiteralPath $extractRoot -Recurse -File | Where-Object Name -eq $coreInfo.executable | Select-Object -First 1
if (!$coreFile) { throw 'Executable not found in core archive' }
Get-ChildItem -LiteralPath $coreFile.Directory.FullName -File | Copy-Item -Destination $coreRoot -Force
Invoke-WebRequest -Uri $coreInfo.license -OutFile (Join-Path $coreRoot 'LICENSE') -TimeoutSec 60
Write-Output "$CoreName $($coreInfo.version) downloaded and SHA256 verified."
