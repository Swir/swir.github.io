$ErrorActionPreference = 'Stop'

$project = Join-Path $PSScriptRoot 'SWIR.Desktop.Host.csproj'
$out = Join-Path $PSScriptRoot 'dist\win-x64'

Write-Host 'SWIR OS Desktop Host — Windows Preview 0.1' -ForegroundColor Cyan
Write-Host 'Restoring packages...'
dotnet restore $project

Write-Host 'Building Release...'
dotnet build $project -c Release --no-restore

Write-Host 'Publishing win-x64 host...'
dotnet publish $project -c Release -r win-x64 --self-contained false --no-restore -o $out

Write-Host ''
Write-Host "Published to: $out" -ForegroundColor Green
Write-Host 'Run SWIR.Desktop.Host.exe from a checkout that contains the SWIR OS repository root.'
