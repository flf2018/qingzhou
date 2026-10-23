$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework C# compiler is required to build the TUN supervisor.' }
$output = Join-Path $projectRoot 'build/TunHost.exe'
$source = Join-Path $projectRoot 'native/TunHost.cs'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw 'TUN supervisor build failed.' }
